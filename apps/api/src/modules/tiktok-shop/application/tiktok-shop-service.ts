import { randomBytes } from 'node:crypto';
import type { TiktokStatusDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { TokenCipher } from '../../../shared/infrastructure/token-cipher.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { retentionCutoff, type IncomingOrder, type SalesIngestion } from '../../sales/index.js';
import { compactBreakdown, mapTiktokOrder, readAmounts, wasPaid } from '../domain/tiktok-order.js';
import { mapTiktokProduct, type TiktokProductRow } from '../domain/tiktok-product.js';
import type { LedgerRow, PgTiktokRepository, TiktokConnectionRow } from '../infrastructure/pg-tiktok-repository.js';
import { TiktokApiError, type TiktokApi } from '../infrastructure/tiktok-api.js';

export type TiktokCallbackResult = { ok: true } | { ok: false; reason: 'denied' | 'state' | 'locked' | 'exchange' | 'noshop' | 'taken' };

class FeatureLockedError extends AppError {
  constructor() {
    super('TikTok Shop ainda não está liberado para a sua empresa', 'FEATURE_LOCKED', 403);
  }
}

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const DAY = 86_400_000;
/** O access token dura ~7 dias; renova com folga de 1 hora. */
const REFRESH_MARGIN_MS = 60 * 60_000;
/** Tempo do token em memória (bem menor que a folga de renovação). */
const TOKEN_MEMO_MS = 5 * 60_000;
/** Janela de busca dos pedidos no histórico. */
const WINDOW_MS = 15 * DAY;
/** Sem sinal de vida por 10 min, a sincronização é dada como interrompida (servidor reiniciou). */
const STALE_MS = 10 * 60_000;

/**
 * Integração TikTok Shop: OAuth (state), tokens criptografados com renovação automática, histórico de vendas
 * e conferência das tarifas pelo extrato de cada pedido. Os pedidos entram em `orders` com marketplace
 * `tiktok_shop`, então a Análise Financeira calcula a margem com as mesmas regras do Mercado Livre.
 */
export class TiktokShopService {
  private active = new Set<string>();
  private background = new Set<Promise<void>>();
  /** Token em memória por alguns minutos: a conferência do extrato faz milhares de chamadas e não precisa ir ao banco em cada uma. */
  private tokens = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly db: Database,
    private readonly repo: PgTiktokRepository,
    private readonly api: TiktokApi,
    private readonly cipher: TokenCipher,
    private readonly sales: SalesIngestion,
    private readonly log: Logger,
    private readonly opts: { paceMs?: number } = {},
  ) {}

  // ================= OAuth
  async authorizationUrl(tenantId: string, userId: string): Promise<string> {
    if (!(await this.repo.hasFeature(tenantId))) throw new FeatureLockedError();
    const state = randomBytes(24).toString('base64url');
    await this.repo.saveState(state, tenantId, userId);
    return this.api.authorizationUrl(state);
  }

  async handleCallback(q: { code?: string; state?: string; error?: string }): Promise<TiktokCallbackResult> {
    if (q.error) return { ok: false, reason: 'denied' };
    // autorização aberta fora do sistema (link do Partner Center) chega sem o nosso state: não dá para saber a empresa
    if (!q.code || !q.state) return { ok: false, reason: 'state' };
    const saved = await this.repo.consumeState(q.state);
    if (!saved) return { ok: false, reason: 'state' };
    const tenantId = saved.tenant_id;
    if (!(await this.repo.hasFeature(tenantId))) return { ok: false, reason: 'locked' };

    let tokens;
    let shops;
    try {
      tokens = await this.api.exchangeCode(q.code);
      shops = await this.api.shops(tokens.accessToken);
    } catch (err) {
      this.log.error({ err }, 'TikTok Shop: falha ao trocar o código por token');
      return { ok: false, reason: 'exchange' };
    }
    if (!shops.length) return { ok: false, reason: 'noshop' };

    let connected = 0;
    for (const shop of shops) {
      if ((await this.repo.claimIdentity(shop.id, tenantId)) !== tenantId) continue;
      const id = await this.db.withTenant(tenantId, (db) =>
        this.repo.upsertConnection(db, {
          tenantId,
          shopId: shop.id,
          cipher: shop.cipher,
          nickname: shop.name || tokens.sellerName || 'TikTok Shop',
          access: this.cipher.encrypt(tokens.accessToken),
          refresh: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.accessExpiresAt,
          refreshExpiresAt: tokens.refreshExpiresAt,
        }),
      );
      connected++;
      this.startSync(tenantId, id);
    }
    return connected ? { ok: true } : { ok: false, reason: 'taken' };
  }

  /** Access token válido; perto de expirar, renova (o refresh token muda a cada renovação) com a linha travada. */
  private async accessToken(tenantId: string, connectionId: string): Promise<string> {
    const hit = this.tokens.get(connectionId);
    if (hit && hit.until > Date.now()) return hit.token;
    const token = await this.readToken(tenantId, connectionId);
    this.tokens.set(connectionId, { token, until: Date.now() + TOKEN_MEMO_MS });
    return token;
  }

  private async readToken(tenantId: string, connectionId: string): Promise<string> {
    try {
      return await this.db.withTenant(tenantId, async (db) => {
        const fresh = (c: TiktokConnectionRow) => c.expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS;
        let conn = await this.repo.findConnection(db, connectionId);
        if (!conn) throw new Error('Conexão não encontrada');
        if (conn.status === 'revoked') throw new TiktokApiError('Autorização revogada', 401, null);
        if (fresh(conn)) return this.cipher.decrypt(conn.access_token_enc);
        conn = (await this.repo.findConnection(db, connectionId, true))!;
        if (fresh(conn)) return this.cipher.decrypt(conn.access_token_enc); // outra instância renovou
        const t = await this.api.refresh(this.cipher.decrypt(conn.refresh_token_enc));
        await this.repo.updateTokens(db, conn.id, this.cipher.encrypt(t.accessToken), this.cipher.encrypt(t.refreshToken), t.accessExpiresAt, t.refreshExpiresAt);
        return t.accessToken;
      });
    } catch (err) {
      // recusa do TikTok na renovação (não instabilidade): a autorização acabou; fora da transação para não se perder
      if (err instanceof TiktokApiError && err.code !== null && err.status < 500) {
        await this.db.withTenant(tenantId, (db) => this.repo.markRevoked(db, connectionId, 'Autorização expirada ou revogada. Conecte novamente.'));
      }
      throw err;
    }
  }

  // ================= Status
  async status(tenantId: string): Promise<TiktokStatusDto> {
    if (!(await this.repo.hasFeature(tenantId))) return { configured: false, connections: [] };
    const conns = await this.db.withTenant(tenantId, (db) => this.repo.connections(db));
    return {
      configured: true,
      connections: conns.map((c) => ({
        id: c.id,
        accountId: c.account_id,
        nickname: c.nickname,
        shopId: c.shop_id,
        status: c.status,
        lastError: c.last_error,
        // "rodando" sem sinal de vida = servidor reiniciou no meio; o agendador retoma
        syncing: c.sync_status === 'running' && (this.active.has(c.id) || Date.now() - c.updated_at.getTime() < STALE_MS),
        syncError: c.sync_error,
        ordersImported: c.orders_imported,
        historyDone: c.backfilled,
        lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
      })),
    };
  }

  // ================= Sincronização
  /** Inicia em segundo plano (histórico completo na primeira vez; depois, só o que mudou). */
  startSync(tenantId: string, connectionId: string): void {
    if (this.active.has(connectionId)) return;
    const job: Promise<void> = this.runSync(tenantId, connectionId).finally(() => this.background.delete(job));
    this.background.add(job);
  }

  /** Aguarda as sincronizações em segundo plano (testes e desligamento). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  private async runSync(tenantId: string, connectionId: string): Promise<void> {
    if (this.active.has(connectionId)) return;
    this.active.add(connectionId);
    const mark = (s: Parameters<PgTiktokRepository['setSync']>[2]) => this.db.withTenant(tenantId, (db) => this.repo.setSync(db, connectionId, s));
    try {
      const conn = await this.db.withTenant(tenantId, (db) => this.repo.findConnection(db, connectionId));
      if (!conn || conn.status !== 'active') return;
      const full = !conn.backfilled;
      await mark({ status: 'running', reset: full });
      const now = new Date();
      // histórico: tudo o que a retenção guarda (13 meses)
      const history = new Date(`${retentionCutoff()}T03:00:00Z`);
      if (full) {
        // do mais recente para o mais antigo
        for (let end = now; end > history; end = new Date(end.getTime() - WINDOW_MS)) {
          await this.importOrders(tenantId, conn, new Date(Math.max(history.getTime(), end.getTime() - WINDOW_MS)), end, 'create');
        }
      } else {
        // de hora em hora: pedidos novos e os que mudaram (cancelamento, entrega)
        await this.importOrders(tenantId, conn, new Date(now.getTime() - 3 * DAY), now, 'update');
      }
      const finance = await this.syncFinance(tenantId, conn, history);
      const products = await this.syncProducts(tenantId, conn);
      this.log.info({ tenantId, connectionId, full, ...finance, products: products.count }, 'TikTok Shop: sincronização concluída');
      const warning = [finance.warning, products.warning].filter(Boolean).join(' ') || null;
      await mark({ status: 'idle', error: warning, backfilled: full, synced: true });
    } catch (err) {
      this.log.error({ err, tenantId, connectionId }, 'TikTok Shop: sincronização falhou');
      await mark({ status: 'failed', error: err instanceof TiktokApiError ? err.message : 'Falha inesperada na sincronização' }).catch(() => undefined);
    } finally {
      this.active.delete(connectionId);
    }
  }

  private async importOrders(tenantId: string, conn: TiktokConnectionRow, from: Date, to: Date, by: 'create' | 'update'): Promise<void> {
    let page: string | undefined;
    do {
      const token = await this.accessToken(tenantId, conn.id);
      const { orders, next } = await this.api.searchOrders(token, conn.shop_cipher, from, to, by, page);
      const mapped = orders.map(mapTiktokOrder).filter((o): o is IncomingOrder => o !== null);
      await this.db.withTenant(tenantId, async (db) => {
        await this.sales.upsertOrders(db, tenantId, conn.account_id, 'tiktok_shop', mapped);
        await this.repo.deleteOrders(db, conn.account_id, orders.filter((o) => !wasPaid(o)).map((o) => String(o.id)));
        await this.repo.closeCancelled(db, conn.account_id);
        await this.repo.setSync(db, conn.id, { status: 'running', imported: mapped.length });
      });
      page = next ?? undefined;
      await this.pace();
    } while (page);
  }

  /**
   * Financeiro fiel ao TikTok, em duas partes:
   *  1. Extratos (repasses e ajustes) desde a última leitura → guardados por transação e somados por pedido:
   *     tarifas, frete, devolução e reembolsos passam a ser os do extrato.
   *  2. Pedidos ainda sem repasse → tarifa e frete ESTIMADOS pelo próprio TikTok (já com frete grátis, afiliado e
   *     tarifa por item), no lugar da conta provisória feita na importação.
   * Se o TikTok recusar (ex.: app sem a permissão de Finanças), devolve um aviso e os pedidos ficam com o provisório.
   */
  private async syncFinance(tenantId: string, conn: TiktokConnectionRow, history: Date) {
    const result = { statements: 0, transactions: 0, settledOrders: 0, estimatedOrders: 0, unreadable: 0, warning: null as string | null };
    try {
      // relê os 3 dias anteriores à última leitura: extrato "em processamento" ainda recebe transações
      const from = conn.statements_until ? new Date(conn.statements_until.getTime() - 3 * DAY) : history;
      const startedAt = new Date();
      const touched = new Set<string>();
      let page: string | undefined;
      do {
        const { statements, next } = await this.api.statements(await this.accessToken(tenantId, conn.id), conn.shop_cipher, from, page);
        for (const st of statements) {
          const rows: LedgerRow[] = [];
          let txPage: string | undefined;
          do {
            const { transactions, next: txNext } = await this.api.statementTransactions(await this.accessToken(tenantId, conn.id), conn.shop_cipher, st.id, txPage);
            for (const tx of transactions) {
              const a = readAmounts(tx);
              if (!a.consistent) result.unreadable++;
              const order = tx.order_id || tx.adjustment_order_id || null;
              if (order) touched.add(order);
              rows.push({
                transaction_id: tx.id || `${st.id}:${order ?? ''}:${tx.type ?? ''}`,
                statement_id: st.id,
                statement_time: new Date(st.statement_time * 1000).toISOString(),
                type: tx.type || 'ORDER',
                order_external_id: order,
                revenue: a.revenue, fee: a.fee, shipping: a.shipping, adjustment: a.adjustment, settlement: a.settlement, refund: a.refund,
                breakdown: compactBreakdown(tx),
              });
            }
            txPage = txNext ?? undefined;
            await this.pace();
          } while (txPage);
          await this.db.withTenant(tenantId, async (db) => {
            await this.repo.upsertTransactions(db, tenantId, conn.account_id, rows);
            await this.repo.setSync(db, conn.id, { status: 'running' }); // sinal de vida
          });
          result.statements++;
          result.transactions += rows.length;
        }
        page = next ?? undefined;
      } while (page);

      result.settledOrders = await this.db.withTenant(tenantId, async (db) => {
        const ids = await this.repo.applyLedger(db, conn.account_id, [...touched]);
        await this.sales.recompute(db, ids);
        await this.repo.setStatementsUntil(db, conn.id, startedAt);
        return ids.length;
      });

      // estimativas do TikTok para o que ainda não foi repassado
      page = undefined;
      do {
        const { transactions, next } = await this.api.unsettled(await this.accessToken(tenantId, conn.id), conn.shop_cipher, page);
        const rows = transactions
          .filter((t) => (t.type ?? 'ORDER') === 'ORDER' && t.order_id)
          .map((t) => {
            const a = readAmounts(t, true);
            return { order: String(t.order_id), fee: a.fee, shipping: a.shipping };
          });
        result.estimatedOrders += await this.db.withTenant(tenantId, async (db) => {
          const ids = await this.repo.applyEstimates(db, conn.account_id, rows);
          await this.sales.recompute(db, ids);
          return ids.length;
        });
        page = next ?? undefined;
        await this.pace();
      } while (page);
    } catch (err) {
      if (!(err instanceof TiktokApiError) || err.code === null || err.status >= 500) throw err;
      this.log.error({ err, code: err.code }, 'TikTok Shop: leitura do financeiro recusada');
      result.warning = `Não consegui ler o financeiro do TikTok (${err.message}). Tarifas e fretes estão provisórios.`;
    }
    if (result.unreadable) this.log.error({ unreadable: result.unreadable }, 'TikTok Shop: transações em que a soma das partes não bateu com o líquido');
    return result;
  }

  /**
   * Catálogo da loja inteiro (situação, preço e estoque), para os anúncios pausados do Dashboard. Se o TikTok recusar
   * (ex.: app sem a permissão de Produtos), devolve um aviso e o restante da sincronização segue.
   */
  private async syncProducts(tenantId: string, conn: TiktokConnectionRow) {
    const result = { count: 0, warning: null as string | null };
    try {
      const startedAt = new Date();
      let page: string | undefined;
      do {
        const { products, next } = await this.api.searchProducts(await this.accessToken(tenantId, conn.id), conn.shop_cipher, page);
        const rows = products.map(mapTiktokProduct).filter((p): p is TiktokProductRow => p !== null);
        await this.db.withTenant(tenantId, async (db) => {
          await this.repo.upsertProducts(db, tenantId, conn.account_id, rows);
          await this.repo.setSync(db, conn.id, { status: 'running' }); // sinal de vida
        });
        result.count += rows.length;
        page = next ?? undefined;
        await this.pace();
      } while (page);
      await this.db.withTenant(tenantId, (db) => this.repo.pruneProducts(db, conn.account_id, startedAt));
    } catch (err) {
      if (!(err instanceof TiktokApiError) || err.code === null || err.status >= 500) throw err;
      this.log.error({ err, code: err.code }, 'TikTok Shop: leitura dos produtos recusada');
      result.warning = `Não consegui ler os produtos do TikTok (${err.message}). Os anúncios pausados não aparecem no Dashboard.`;
    }
    return result;
  }

  private pace(): Promise<void> {
    const ms = this.opts.paceMs ?? 250;
    return ms ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve();
  }

  // ================= Agendador
  async hourlyTick(now = new Date()): Promise<boolean> {
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    if (!(await this.repo.claimSlot('tiktok_hourly_sync', slot))) return false;
    for (const tenantId of await this.repo.connectedTenants()) {
      const conns = await this.db.withTenant(tenantId, (db) => this.repo.connections(db));
      for (const c of conns.filter((x) => x.status === 'active')) await this.runSync(tenantId, c.id);
    }
    return true;
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      const next = Math.ceil((now + 1) / 3_600_000) * 3_600_000 + 5 * 60_000; // hh:05, depois do Mercado Livre
      timer = setTimeout(() => {
        this.hourlyTick().catch((err) => this.log.error({ err }, 'TikTok Shop: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    this.log.info({}, 'TikTok Shop: atualização automática de hora em hora ativa');
    return () => clearTimeout(timer);
  }
}
