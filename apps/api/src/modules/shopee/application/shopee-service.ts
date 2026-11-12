import { randomBytes } from 'node:crypto';
import type { ShopeeFunnelDto, ShopeeStatusDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { TokenCipher } from '../../../shared/infrastructure/token-cipher.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { retentionCutoff, type IncomingOrder, type SalesIngestion } from '../../sales/index.js';
import { mapAdsDay, mapShopeeItem } from '../domain/shopee-ads.js';
import { mapShopeeEscrow } from '../domain/shopee-escrow.js';
import { mapShopeeOrder, placedOrder, wasPaid } from '../domain/shopee-order.js';
import type { EscrowWrite, PgShopeeRepository, ShopeeConnectionRow } from '../infrastructure/pg-shopee-repository.js';
import { SHOPEE_BATCH, ShopeeApiError, type ShopeeApi } from '../infrastructure/shopee-api.js';

export type ShopeeCallbackResult = { ok: true } | { ok: false; reason: 'denied' | 'state' | 'locked' | 'exchange' | 'noshop' | 'taken' };

class FeatureLockedError extends AppError {
  constructor() {
    super('A Shopee ainda não está liberada para a sua empresa', 'FEATURE_LOCKED', 403);
  }
}

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const DAY = 86_400_000;
/** O access token dura 4 horas; renova com folga de 30 minutos. */
const REFRESH_MARGIN_MS = 30 * 60_000;
/** Tempo do token em memória (bem menor que a folga de renovação). */
const TOKEN_MEMO_MS = 5 * 60_000;
/** Janela máxima das listas da Shopee (pedidos e repasses): 15 dias. */
const WINDOW_MS = 15 * DAY - 60_000;
/** Sem sinal de vida por 10 min, a sincronização é dada como interrompida (servidor reiniciou). */
const STALE_MS = 10 * 60_000;
/** Janela de cada leitura do Shopee Ads (a Shopee aceita até um mês). */
const ADS_WINDOW_DAYS = 30;
/** Situações de anúncio que contam como pausado no Dashboard. */
const PAUSED_STATUSES = ['UNLIST', 'BANNED'];
/** Erros da Shopee que significam autorização acabada (não instabilidade). */
const AUTH_ERRORS = /error_auth|invalid_acc?ess_token|invalid_refresh_token|partner_shop_no_link|shop_no_linked|error_partner_key_expired|shop_banned/;

/**
 * Integração Shopee: OAuth (state), tokens criptografados com renovação automática, histórico de vendas e o escrow
 * (repasse) de cada pedido. Os pedidos entram em `orders` com marketplace `shopee`; o escrow define produto, cupom,
 * tarifa e fretes, e a margem fecha com o repasse (MC = repasse − custo − imposto), como no NVS W2.
 */
export class ShopeeService {
  private active = new Set<string>();
  private background = new Set<Promise<void>>();
  private tokens = new Map<string, { token: string; until: number }>();

  constructor(
    private readonly db: Database,
    private readonly repo: PgShopeeRepository,
    private readonly api: ShopeeApi,
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

  async handleCallback(q: { code?: string; state?: string; shop_id?: string; main_account_id?: string; error?: string }): Promise<ShopeeCallbackResult> {
    if (q.error) return { ok: false, reason: 'denied' };
    if (!q.code || !q.state) return { ok: false, reason: 'state' };
    const saved = await this.repo.consumeState(q.state);
    if (!saved) return { ok: false, reason: 'state' };
    const tenantId = saved.tenant_id;
    if (!(await this.repo.hasFeature(tenantId))) return { ok: false, reason: 'locked' };
    if (!q.shop_id && !q.main_account_id) return { ok: false, reason: 'noshop' };

    let tokens;
    try {
      tokens = await this.api.exchangeCode(q.code, { shopId: q.shop_id, mainAccountId: q.main_account_id });
    } catch (err) {
      this.log.error({ err }, 'Shopee: falha ao trocar o código por token');
      return { ok: false, reason: 'exchange' };
    }
    if (!tokens.shopIds.length) return { ok: false, reason: 'noshop' };

    let connected = 0;
    for (const shopId of tokens.shopIds) {
      if ((await this.repo.claimIdentity(shopId, tenantId)) !== tenantId) continue;
      // conta principal: o token vale para todas as lojas; cada uma passa a renovar o seu
      const info = await this.api.shopInfo(tokens.accessToken, shopId).catch(() => null);
      const id = await this.db.withTenant(tenantId, (db) =>
        this.repo.upsertConnection(db, {
          tenantId,
          shopId,
          nickname: info?.name || `Shopee ${shopId}`,
          access: this.cipher.encrypt(tokens.accessToken),
          refresh: this.cipher.encrypt(tokens.refreshToken),
          expiresAt: tokens.accessExpiresAt,
          authExpiresAt: info?.authExpiresAt ?? null,
        }),
      );
      this.tokens.delete(id);
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
        const fresh = (c: ShopeeConnectionRow) => c.expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS;
        let conn = await this.repo.findConnection(db, connectionId);
        if (!conn) throw new Error('Conexão não encontrada');
        if (conn.status === 'revoked') throw new ShopeeApiError('Autorização revogada', 401, 'error_auth');
        if (fresh(conn)) return this.cipher.decrypt(conn.access_token_enc);
        conn = (await this.repo.findConnection(db, connectionId, true))!;
        if (fresh(conn)) return this.cipher.decrypt(conn.access_token_enc); // outra instância renovou
        const t = await this.api.refresh(this.cipher.decrypt(conn.refresh_token_enc), conn.shop_id);
        await this.repo.updateTokens(db, conn.id, this.cipher.encrypt(t.accessToken), this.cipher.encrypt(t.refreshToken), t.accessExpiresAt);
        return t.accessToken;
      });
    } catch (err) {
      // recusa da Shopee na renovação (não instabilidade): a autorização acabou; fora da transação para não se perder
      if (err instanceof ShopeeApiError && err.code && AUTH_ERRORS.test(err.code)) {
        await this.db.withTenant(tenantId, (db) => this.repo.markRevoked(db, connectionId, 'Autorização expirada ou revogada. Conecte novamente.'));
      }
      throw err;
    }
  }

  // ================= Status
  async status(tenantId: string): Promise<ShopeeStatusDto> {
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
        syncing: c.sync_status === 'running' && (this.active.has(c.id) || Date.now() - c.updated_at.getTime() < STALE_MS),
        syncError: c.sync_error,
        ordersImported: c.orders_imported,
        historyDone: c.backfilled,
        lastSyncedAt: c.last_synced_at?.toISOString() ?? null,
        authExpiresAt: c.auth_expires_at?.toISOString() ?? null,
      })),
    };
  }

  // ================= Funil Pedido Feito × Pedido Pago
  async funnel(tenantId: string, from: string, to: string, accountId?: string): Promise<ShopeeFunnelDto> {
    if (!(await this.repo.hasFeature(tenantId))) throw new FeatureLockedError();
    const r = await this.db.withTenant(tenantId, (db) => this.repo.funnel(db, from, to, accountId));
    return {
      feitos: { pedidos: r.feitos, valor: Number(r.feitos_valor) },
      pagos: { pedidos: r.pagos, valor: Number(r.pagos_valor) },
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
    const mark = (s: Parameters<PgShopeeRepository['setSync']>[2]) => this.db.withTenant(tenantId, (db) => this.repo.setSync(db, connectionId, s));
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
          await this.importOrders(tenantId, conn, new Date(Math.max(history.getTime(), end.getTime() - WINDOW_MS)), end, 'create_time');
        }
      } else {
        // de hora em hora: pedidos novos e os que mudaram (cancelamento, entrega, devolução)
        await this.importOrders(tenantId, conn, new Date(now.getTime() - 3 * DAY), now, 'update_time');
      }
      const escrow = await this.syncEscrow(tenantId, conn, history, now);
      const ads = await this.syncAds(tenantId, conn, full, now);
      const products = await this.syncProducts(tenantId, conn);
      // renova a validade da autorização mostrada em Integrações
      const info = await this.api.shopInfo(await this.accessToken(tenantId, conn.id), conn.shop_id).catch(() => null);
      if (info) await this.db.withTenant(tenantId, (db) => this.repo.setAuthExpiry(db, conn.id, info.authExpiresAt));
      this.log.info({ tenantId, connectionId, full, ...escrow, adsDays: ads.days, paused: products.count }, 'Shopee: sincronização concluída');
      const warning = [escrow.warning, products.warning].filter(Boolean).join(' ') || null;
      await mark({ status: 'idle', error: warning, backfilled: full, synced: true });
    } catch (err) {
      this.log.error({ err, tenantId, connectionId }, 'Shopee: sincronização falhou');
      await mark({ status: 'failed', error: err instanceof ShopeeApiError ? err.message : 'Falha inesperada na sincronização' }).catch(() => undefined);
    } finally {
      this.active.delete(connectionId);
    }
  }

  private async importOrders(tenantId: string, conn: ShopeeConnectionRow, from: Date, to: Date, field: 'create_time' | 'update_time'): Promise<void> {
    let cursor: string | undefined;
    do {
      const { orderSns, next } = await this.api.orderList(await this.accessToken(tenantId, conn.id), conn.shop_id, from, to, field, cursor);
      for (let i = 0; i < orderSns.length; i += SHOPEE_BATCH) {
        const orders = await this.api.orderDetails(await this.accessToken(tenantId, conn.id), conn.shop_id, orderSns.slice(i, i + SHOPEE_BATCH));
        const mapped = orders.map(mapShopeeOrder).filter((o): o is IncomingOrder => o !== null);
        await this.db.withTenant(tenantId, async (db) => {
          await this.sales.upsertOrders(db, tenantId, conn.account_id, 'shopee', mapped);
          await this.repo.upsertPlaced(db, tenantId, conn.account_id, orders.map(placedOrder));
          await this.repo.deleteOrders(db, conn.account_id, orders.filter((o) => !wasPaid(o)).map((o) => o.order_sn));
          await this.repo.closeCancelled(db, conn.account_id);
          // a reimportação volta aos valores do pedido: o escrow já lido é reaplicado na hora
          const ids = await this.repo.applyEscrows(db, conn.account_id, mapped.map((o) => o.externalId));
          await this.sales.recompute(db, ids);
          await this.repo.setSync(db, conn.id, { status: 'running', imported: mapped.length });
        });
        await this.pace();
      }
      cursor = next ?? undefined;
    } while (cursor);
  }

  /**
   * Escrow (repasse) por pedido, em duas partes:
   *  1. Repasses liberados desde a última leitura (lista de escrow) → escrow definitivo; o pedido fica conferido.
   *  2. Vendas ainda sem repasse → escrow estimado pela própria Shopee (já com comissão, frete e subsídios).
   * Se a Shopee recusar (ex.: app sem a permissão de Payment), devolve um aviso e os pedidos ficam com o valor do pedido.
   */
  private async syncEscrow(tenantId: string, conn: ShopeeConnectionRow, history: Date, now: Date) {
    const result = { released: 0, estimated: 0, unreadable: 0, warning: null as string | null };
    try {
      // relê 3 dias antes da última leitura, por segurança
      const start = conn.escrow_until ? new Date(Math.max(history.getTime(), conn.escrow_until.getTime() - 3 * DAY)) : history;
      const released: { orderSn: string; payout: number; releasedAt: Date }[] = [];
      for (let from = start; from < now; from = new Date(from.getTime() + WINDOW_MS)) {
        const to = new Date(Math.min(now.getTime(), from.getTime() + WINDOW_MS));
        for (let page = 1; ; page++) {
          const r = await this.api.escrowList(await this.accessToken(tenantId, conn.id), conn.shop_id, from, to, page);
          released.push(...r.released);
          await this.pace();
          if (!r.more || !r.released.length) break;
        }
      }
      const releasedBySn = new Map(released.map((r) => [r.orderSn, r]));
      // de hora em hora, só os últimos 90 dias (venda que nunca é liberada, como devolução, não fica sendo relida para sempre)
      const since = conn.backfilled ? new Date(Math.max(history.getTime(), now.getTime() - 90 * DAY)) : history;
      const pending = await this.db.withTenant(tenantId, (db) => this.repo.unsettledOrders(db, conn.account_id, since));
      // só pedidos que estão no sistema (o escrow de pedido fora da retenção não tem onde entrar)
      const known = new Set(pending);
      const settledSns = [...releasedBySn.keys()].filter((sn) => known.has(sn));
      const estimateSns = pending.filter((sn) => !releasedBySn.has(sn));

      for (const [sns, settled] of [[settledSns, true], [estimateSns, false]] as const) {
        for (let i = 0; i < sns.length; i += SHOPEE_BATCH) {
          const details = await this.api.escrowDetails(await this.accessToken(tenantId, conn.id), conn.shop_id, sns.slice(i, i + SHOPEE_BATCH));
          const rows: EscrowWrite[] = [];
          for (const d of details) {
            try {
              const m = mapShopeeEscrow(d);
              const rel = releasedBySn.get(m.order_sn);
              rows.push({ ...m, settled, released_at: rel?.releasedAt.toISOString() ?? null, payout_amount: rel?.payout ?? null });
            } catch {
              result.unreadable++;
            }
          }
          await this.db.withTenant(tenantId, async (db) => {
            await this.repo.upsertEscrows(db, tenantId, conn.account_id, rows);
            const ids = await this.repo.applyEscrows(db, conn.account_id, rows.map((r) => r.order_sn));
            await this.sales.recompute(db, ids);
            await this.repo.setSync(db, conn.id, { status: 'running' }); // sinal de vida
          });
          if (settled) result.released += rows.length;
          else result.estimated += rows.length;
          await this.pace();
        }
      }
      await this.db.withTenant(tenantId, (db) => this.repo.setEscrowUntil(db, conn.id, now));
    } catch (err) {
      if (!(err instanceof ShopeeApiError) || !err.code || (err.code && AUTH_ERRORS.test(err.code))) throw err;
      this.log.error({ err, code: err.code }, 'Shopee: leitura do escrow recusada');
      result.warning = `Não consegui ler o repasse da Shopee (${err.message}). Tarifas e fretes estão provisórios.`;
    }
    if (result.unreadable) this.log.error({ unreadable: result.unreadable }, 'Shopee: escrows sem order_income');
    return result;
  }

  /**
   * Gasto diário do Shopee Ads (todas as campanhas), como o Mercado Ads. Primeira vez: 6 meses (o que a Shopee guarda);
   * depois, os últimos 7 dias (o dia de hoje ainda muda). Recusa da Shopee (ex.: app sem a permissão de Ads) fica
   * registrada na conexão e o Ads cai na recarga descontada dos repasses.
   */
  private async syncAds(tenantId: string, conn: ShopeeConnectionRow, full: boolean, now: Date) {
    const result = { days: 0 };
    const iso = (d: Date) => new Date(d.getTime() - 3 * 3_600_000).toISOString().slice(0, 10); // dia de São Paulo
    try {
      const today = iso(now);
      for (let from = new Date(now.getTime() - (full || conn.ads_error ? 180 : 7) * DAY); iso(from) <= today; from = new Date(from.getTime() + ADS_WINDOW_DAYS * DAY)) {
        const last = iso(new Date(from.getTime() + (ADS_WINDOW_DAYS - 1) * DAY));
        const perf = await this.api.adsDaily(await this.accessToken(tenantId, conn.id), conn.shop_id, iso(from), last < today ? last : today);
        const days = perf.map(mapAdsDay).filter((d): d is NonNullable<typeof d> => d !== null);
        await this.db.withTenant(tenantId, (db) => this.repo.upsertAdsDaily(db, tenantId, conn.account_id, days));
        result.days += days.length;
        await this.pace();
      }
      await this.db.withTenant(tenantId, (db) => this.repo.setAds(db, conn.id, null));
    } catch (err) {
      if (!(err instanceof ShopeeApiError) || !err.code || AUTH_ERRORS.test(err.code)) throw err;
      this.log.error({ err, code: err.code }, 'Shopee: leitura do Shopee Ads recusada');
      await this.db.withTenant(tenantId, (db) => this.repo.setAds(db, conn.id, `Não consegui ler o Shopee Ads (${err.message}).`));
    }
    return result;
  }

  /** Anúncios fora do ar (deslistados ou bloqueados), para os pausados do Dashboard. Recusa vira aviso. */
  private async syncProducts(tenantId: string, conn: ShopeeConnectionRow) {
    const result = { count: 0, warning: null as string | null };
    try {
      const startedAt = new Date();
      for (const status of PAUSED_STATUSES) {
        let offset: number | null = 0;
        while (offset !== null) {
          const page = await this.api.itemList(await this.accessToken(tenantId, conn.id), conn.shop_id, status, offset);
          for (let i = 0; i < page.itemIds.length; i += SHOPEE_BATCH) {
            const items = await this.api.itemInfo(await this.accessToken(tenantId, conn.id), conn.shop_id, page.itemIds.slice(i, i + SHOPEE_BATCH));
            const rows = items.map((it) => mapShopeeItem(it, status));
            await this.db.withTenant(tenantId, (db) => this.repo.upsertProducts(db, tenantId, conn.account_id, rows));
            result.count += rows.length;
          }
          offset = page.next;
          await this.pace();
        }
      }
      await this.db.withTenant(tenantId, (db) => this.repo.pruneProducts(db, conn.account_id, startedAt));
    } catch (err) {
      if (!(err instanceof ShopeeApiError) || !err.code || AUTH_ERRORS.test(err.code)) throw err;
      this.log.error({ err, code: err.code }, 'Shopee: leitura dos anúncios recusada');
      result.warning = `Não consegui ler os anúncios da Shopee (${err.message}). Os pausados não aparecem no Dashboard.`;
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
    if (!(await this.repo.claimSlot('shopee_hourly_sync', slot))) return false;
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
      const next = Math.ceil((now + 1) / 3_600_000) * 3_600_000 + 10 * 60_000; // hh:10, depois do ML e do TikTok
      timer = setTimeout(() => {
        this.hourlyTick().catch((err) => this.log.error({ err }, 'Shopee: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    this.log.info({}, 'Shopee: atualização automática de hora em hora ativa');
    return () => clearTimeout(timer);
  }
}
