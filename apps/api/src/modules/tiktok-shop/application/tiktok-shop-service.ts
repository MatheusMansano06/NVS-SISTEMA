import { randomBytes } from 'node:crypto';
import type { TiktokStatusDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { TokenCipher } from '../../../shared/infrastructure/token-cipher.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { retentionCutoff, type IncomingOrder, type SalesIngestion } from '../../sales/index.js';
import { mapTiktokOrder, parseSettlement } from '../domain/tiktok-order.js';
import type { PgTiktokRepository, TiktokConnectionRow } from '../infrastructure/pg-tiktok-repository.js';
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
/** O repasse só sai depois da entrega: pedidos muito novos nem são consultados. */
const SETTLE_AFTER_MS = 2 * DAY;

/**
 * Integração TikTok Shop: OAuth (state), tokens criptografados com renovação automática, histórico de vendas
 * e conferência das tarifas pelo extrato de cada pedido. Os pedidos entram em `orders` com marketplace
 * `tiktok_shop`, então a Análise Financeira calcula a margem com as mesmas regras do Mercado Livre.
 */
export class TiktokShopService {
  private active = new Set<string>();
  private background = new Set<Promise<void>>();
  /** Uma amostra do formato real por processo (sem dados do comprador), para conferir os campos da API. */
  private sampled = { order: false, settlement: false, unsettled: false };
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
  /**
   * Inicia em segundo plano (histórico completo na primeira vez; depois, só o que mudou).
   * `deep` (botão "Sincronizar agora"): confere o extrato de TODAS as vendas ainda com tarifa estimada.
   */
  startSync(tenantId: string, connectionId: string, deep = false): void {
    if (this.active.has(connectionId)) return;
    const job: Promise<void> = this.runSync(tenantId, connectionId, deep).finally(() => this.background.delete(job));
    this.background.add(job);
  }

  /** Aguarda as sincronizações em segundo plano (testes e desligamento). */
  async idle(): Promise<void> {
    await Promise.allSettled([...this.background]);
  }

  private async runSync(tenantId: string, connectionId: string, deep = false): Promise<void> {
    if (this.active.has(connectionId)) return;
    this.active.add(connectionId);
    const mark = (s: Parameters<PgTiktokRepository['setSync']>[2]) => this.db.withTenant(tenantId, (db) => this.repo.setSync(db, connectionId, s));
    try {
      const conn = await this.db.withTenant(tenantId, (db) => this.repo.findConnection(db, connectionId));
      if (!conn || conn.status !== 'active') return;
      const full = !conn.backfilled;
      await mark({ status: 'running', reset: full });
      const now = new Date();
      if (full) {
        // histórico: tudo o que a retenção guarda (13 meses), do mais recente para o mais antigo
        const from = new Date(`${retentionCutoff()}T03:00:00Z`);
        for (let end = now; end > from; end = new Date(end.getTime() - WINDOW_MS)) {
          await this.importOrders(tenantId, conn, new Date(Math.max(from.getTime(), end.getTime() - WINDOW_MS)), end, 'create');
        }
      } else {
        // de hora em hora: pedidos novos e os que mudaram (cancelamento, entrega)
        await this.importOrders(tenantId, conn, new Date(now.getTime() - 3 * DAY), now, 'update');
      }
      const all = full || deep;
      const settled = await this.settle(tenantId, conn, all ? new Date(0) : new Date(now.getTime() - 60 * DAY), all ? 50_000 : 400);
      this.log.info({ tenantId, connectionId, full, deep, ...settled }, 'TikTok Shop: sincronização concluída');
      await mark({ status: 'idle', error: settled.warning, backfilled: full, synced: true });
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
      if (!this.sampled.order && orders[0]) {
        this.sampled.order = true;
        const o = orders[0];
        this.log.info({ keys: Object.keys(o), status: o.status, payment: o.payment, lineItem: o.line_items?.[0] }, 'TikTok Shop: amostra de pedido');
      }
      const mapped = orders.map(mapTiktokOrder).filter((o): o is IncomingOrder => o !== null);
      await this.db.withTenant(tenantId, async (db) => {
        await this.sales.upsertOrders(db, tenantId, conn.account_id, 'tiktok_shop', mapped);
        await this.repo.closeCancelled(db, conn.account_id);
        await this.repo.setSync(db, conn.id, { status: 'running', imported: mapped.length });
      });
      page = next ?? undefined;
      await this.pace();
    } while (page);
  }

  /**
   * Troca a tarifa estimada pela cobrada de fato (extrato do pedido) e grava o frete pago pelo vendedor.
   * Retorna um aviso quando o TikTok recusa o extrato (ex.: app sem a permissão de Finanças): os pedidos
   * continuam valendo com a tarifa estimada.
   */
  private async settle(tenantId: string, conn: TiktokConnectionRow, since: Date, limit: number): Promise<{ pending: number; settled: number; warning: string | null }> {
    const until = new Date(Date.now() - SETTLE_AFTER_MS);
    const pending = await this.db.withTenant(tenantId, (db) => this.repo.pendingSettlement(db, conn.account_id, since, until, limit));
    let n = 0;
    let settled = 0;
    for (const o of pending) {
      const token = await this.accessToken(tenantId, conn.id);
      let data: unknown;
      try {
        data = await this.api.orderTransactions(token, conn.shop_cipher, o.external_id);
      } catch (err) {
        if (err instanceof TiktokApiError && err.code !== null && err.status < 500) {
          this.log.error({ err, code: err.code }, 'TikTok Shop: extrato do pedido recusado');
          return { pending: pending.length, settled, warning: `Não consegui ler o extrato financeiro (${err.message}). As tarifas estão estimadas.` };
        }
        throw err;
      }
      const s = parseSettlement(data);
      if (!s && !this.sampled.unsettled) {
        // formato de quem ainda não foi repassado (ou que o leitor não reconheceu): uma amostra para conferência
        this.sampled.unsettled = true;
        this.log.info({ sample: JSON.stringify(data).slice(0, 2000) }, 'TikTok Shop: amostra de extrato sem repasse');
      }
      if (s) {
        settled++;
        if (!this.sampled.settlement) {
          this.sampled.settlement = true;
          this.log.info({ sample: JSON.stringify(data).slice(0, 4000) }, 'TikTok Shop: amostra de extrato do pedido');
        }
        await this.db.withTenant(tenantId, async (db) => {
          await this.repo.setSettlement(db, o.id, s.fee, s.shipping);
          await this.sales.recompute(db, [o.id]);
        });
      }
      // sinal de vida a cada 25 pedidos
      if (++n % 25 === 0) await this.db.withTenant(tenantId, (db) => this.repo.setSync(db, conn.id, { status: 'running' }));
      await this.pace();
    }
    return { pending: pending.length, settled, warning: null };
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
