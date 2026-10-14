import { createHash, randomBytes } from 'node:crypto';
import type { MlStatusDto, SyncPhase } from '@nvs/shared';
import { SYNC_PHASE_END } from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import type { TokenCipher } from '../../../shared/infrastructure/token-cipher.js';
import type { EventBus } from '../../../shared/kernel/event-bus.js';
import type { SalesIngestion } from '../../sales/index.js';
import { feeBonusOf, mapMlItem, mapMlOrder, type MlOrder } from '../domain/ml-order.js';
import { billedDifal, sellerCoupon, sellerPaidFreight, shipmentAddress, shipmentFreight } from '../domain/ml-finance.js';
import { MlApiError, ORDERS_PAGE_SIZE, type MlApi } from '../infrastructure/ml-api.js';
import type { ConnectionRow, PgMlRepository } from '../infrastructure/pg-ml-repository.js';

export type CallbackResult =
  | { ok: true; tenantId: string; connectionId: string }
  | { ok: false; reason: 'denied' | 'state' | 'exchange' | 'taken' };

export interface MlNotification {
  topic?: string;
  resource?: string;
  user_id?: number | string;
  application_id?: number | string;
}

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

const DAY = 86_400_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_OFFSET = 10_000; // limite de paginação da busca de pedidos
// a busca do ML espera o fuso explícito; "-00:00" equivale a UTC
const mlDate = (d: Date) => d.toISOString().replace('Z', '-00:00');

const PHASE_START: Record<SyncPhase, number> = {
  profile: 0,
  orders_recent: SYNC_PHASE_END.profile,
  listings: SYNC_PHASE_END.orders_recent,
  orders_history: SYNC_PHASE_END.listings,
  shipping_costs: SYNC_PHASE_END.orders_history,
  finishing: SYNC_PHASE_END.shipping_costs,
};
/** Sinal de vida da sincronização: sem ele por 3 min, a execução é dada como interrompida (servidor reiniciou). */
const HEARTBEAT_MS = 30_000;
const MAX_LISTING_PAGES = 200; // até 20 mil anúncios por status (scan de 100 em 100)

/**
 * Integração Mercado Livre: OAuth (state + PKCE), tokens criptografados com renovação
 * automática, sincronização progressiva em etapas e notificações em tempo real.
 */
export class MlIntegrationService {
  /** Chamado no "Sincronizar agora" (Dashboard): outros módulos que leem do ML (devoluções) sincronizam junto. */
  onManualSync: ((tenantId: string) => void) | null = null;

  private inflight = new Set<Promise<void>>();
  /** Conexões com sincronização completa rodando neste processo: um segundo clique não abre outra. */
  private activeSyncs = new Set<string>();
  private processingOrders = new Set<string>();
  private refreshing = new Map<string, Promise<{ token: string; conn: ConnectionRow }>>();
  // fila de notificações: o ML reenvia muito; repetidas em 30s são descartadas e a fila tem limite
  private notifSeen = new Map<string, number>();
  private notifQueue: MlNotification[] = [];
  private notifWorkers = 0;

  constructor(
    private readonly db: Database,
    private readonly repo: PgMlRepository,
    private readonly api: MlApi,
    private readonly cipher: TokenCipher,
    private readonly sales: SalesIngestion,
    private readonly events: EventBus,
    private readonly log: Logger,
    private readonly opts: { clientId: string; usePkce: boolean },
  ) {}

  // ================= OAuth
  async authorizationUrl(tenantId: string, userId: string): Promise<string> {
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    await this.repo.saveState(state, tenantId, userId, verifier);
    const challenge = this.opts.usePkce ? createHash('sha256').update(verifier).digest('base64url') : null;
    return this.api.authorizationUrl(state, challenge);
  }

  async handleCallback(q: { code?: string; state?: string; error?: string }): Promise<CallbackResult> {
    if (q.error) return { ok: false, reason: 'denied' };
    if (!q.code || !q.state) return { ok: false, reason: 'state' };
    const saved = await this.repo.consumeState(q.state);
    if (!saved) return { ok: false, reason: 'state' };

    let tokens;
    let me;
    try {
      tokens = await this.api.exchangeCode(q.code, this.opts.usePkce ? saved.code_verifier : null);
      me = await this.api.me(tokens.access_token);
    } catch (err) {
      this.log.error({ err }, 'Mercado Livre: falha ao trocar o código por token');
      return { ok: false, reason: 'exchange' };
    }

    const mlUserId = String(me.id);
    const owner = await this.repo.claimIdentity(mlUserId, saved.tenant_id);
    if (owner !== saved.tenant_id) return { ok: false, reason: 'taken' };

    const connectionId = await this.db.withTenant(saved.tenant_id, (db) =>
      this.repo.upsertConnection(db, {
        tenantId: saved.tenant_id,
        mlUserId,
        nickname: me.nickname,
        access: this.cipher.encrypt(tokens.access_token),
        refresh: this.cipher.encrypt(tokens.refresh_token),
        expiresAt: new Date(Date.now() + tokens.expires_in * 1000),
      }),
    );
    this.events.publish({ type: 'marketplace.connected', tenantId: saved.tenant_id, payload: { marketplace: 'mercado_livre', mlUserId } });
    await this.startSync(saved.tenant_id, connectionId);
    return { ok: true, tenantId: saved.tenant_id, connectionId };
  }

  /**
   * Access token válido. Caminho rápido: leitura simples (sem trava). Perto de expirar, renova com o refresh
   * token (uso único) — uma renovação por conexão por vez nesta instância (as outras requisições esperam a
   * mesma promessa em vez de ocupar conexões do pool) e com trava na linha entre instâncias.
   */
  async accessToken(tenantId: string, connectionId: string): Promise<{ token: string; conn: ConnectionRow }> {
    const conn = await this.db.withTenant(tenantId, (db) => this.repo.findConnection(db, connectionId));
    if (!conn) throw new Error('Conexão não encontrada');
    if (conn.status === 'revoked') throw new MlApiError('Autorização revogada', 401, 'revoked');
    if (conn.expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS) {
      return { token: this.cipher.decrypt(conn.access_token_enc), conn };
    }
    const running = this.refreshing.get(connectionId);
    if (running) return running;
    const job = this.refreshToken(tenantId, connectionId).finally(() => this.refreshing.delete(connectionId));
    this.refreshing.set(connectionId, job);
    return job;
  }

  private refreshToken(tenantId: string, connectionId: string): Promise<{ token: string; conn: ConnectionRow }> {
    return this.db.withTenant(tenantId, async (db) => {
      const conn = await this.repo.lockConnection(db, connectionId);
      if (!conn) throw new Error('Conexão não encontrada');
      if (conn.status === 'revoked') throw new MlApiError('Autorização revogada', 401, 'revoked');
      // outra instância pode ter renovado enquanto esperávamos a trava
      if (conn.expires_at.getTime() - Date.now() > REFRESH_MARGIN_MS) {
        return { token: this.cipher.decrypt(conn.access_token_enc), conn };
      }
      try {
        const t = await this.api.refresh(this.cipher.decrypt(conn.refresh_token_enc));
        await this.repo.updateTokens(
          db,
          conn.id,
          this.cipher.encrypt(t.access_token),
          this.cipher.encrypt(t.refresh_token),
          new Date(Date.now() + t.expires_in * 1000),
        );
        return { token: t.access_token, conn };
      } catch (err) {
        if (err instanceof MlApiError && (err.code === 'invalid_grant' || err.status === 400 || err.status === 401)) {
          await this.repo.markConnection(db, conn.id, 'revoked', 'Autorização expirada ou revogada. Conecte novamente.');
        }
        throw err;
      }
    });
  }

  // ================= Status
  async status(tenantId: string): Promise<MlStatusDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const conns = await this.repo.connections(db);
      const result = [];
      for (const c of conns) {
        const run = await this.repo.latestRun(db, c.id);
        const synced = await this.repo.lastSyncedAt(db, c.id);
        result.push({
          id: c.id,
          accountId: c.account_id,
          nickname: c.nickname,
          mlUserId: c.ml_user_id,
          status: c.status,
          lastError: c.last_error,
          sync: run && {
            status: run.status,
            phase: run.phase,
            progress: run.progress,
            ordersImported: run.orders_imported,
            error: run.error,
            startedAt: run.started_at.toISOString(),
            finishedAt: run.finished_at?.toISOString() ?? null,
          },
          lastSyncedAt: synced?.toISOString() ?? null,
        });
      }
      return { configured: true, connections: result };
    });
  }

  // ================= Sincronização progressiva
  /** Inicia (em segundo plano) se não houver uma em andamento. */
  async startSync(tenantId: string, connectionId: string): Promise<void> {
    if (this.activeSyncs.has(connectionId)) return;
    const runId = await this.db.withTenant(tenantId, async (db) => {
      await this.repo.lockSync(db, connectionId); // dois cliques seguidos não abrem duas sincronizações
      const last = await this.repo.latestRun(db, connectionId);
      if (last?.status === 'running') return null;
      return this.repo.startRun(db, tenantId, connectionId);
    });
    if (!runId) return;
    this.activeSyncs.add(connectionId);
    // sinal de vida enquanto roda: etapas longas (frete pago, fatura) não parecem "interrompidas"
    const beat = setInterval(() => void this.run(tenantId, runId, {}).catch(() => undefined), HEARTBEAT_MS);
    beat.unref();
    const job = this.runSync(tenantId, connectionId, runId)
      .catch((err) => this.log.error({ err }, 'Mercado Livre: sincronização falhou'))
      .finally(() => {
        clearInterval(beat);
        this.activeSyncs.delete(connectionId);
        this.inflight.delete(job);
      });
    this.inflight.add(job);
  }

  /** Aguarda sincronizações em andamento (testes e desligamento gracioso). */
  async whenIdle(): Promise<void> {
    while (this.inflight.size) await Promise.all([...this.inflight]);
  }

  private run(tenantId: string, runId: string, p: Parameters<PgMlRepository['updateRun']>[2]) {
    return this.db.withTenant(tenantId, (db) => this.repo.updateRun(db, runId, p));
  }

  private async runSync(tenantId: string, connectionId: string, runId: string): Promise<void> {
    try {
      // 1. perfil
      const { token, conn } = await this.accessToken(tenantId, connectionId);
      const me = await this.api.me(token);
      await this.db.withTenant(tenantId, (db) => this.repo.updateNickname(db, conn.account_id, me.nickname));
      await this.run(tenantId, runId, { phase: 'orders_recent', progress: SYNC_PHASE_END.profile });

      // 2 e 3. pedidos: primeiro o recente (dashboard útil logo), depois o histórico
      const now = new Date();
      const d30 = new Date(now.getTime() - 30 * DAY);
      const d90 = new Date(now.getTime() - 90 * DAY);
      await this.importRange(tenantId, connectionId, runId, conn, d30, now, 'orders_recent');
      await this.run(tenantId, runId, { phase: 'listings', progress: SYNC_PHASE_END.orders_recent });

      // anúncios: pausados + fotos dos mais vendidos
      await this.syncListings(tenantId, connectionId, runId, conn);
      await this.run(tenantId, runId, { phase: 'orders_history', progress: SYNC_PHASE_END.listings });
      await this.importRange(tenantId, connectionId, runId, conn, d90, d30, 'orders_history');
      await this.run(tenantId, runId, { phase: 'shipping_costs', progress: SYNC_PHASE_END.orders_history });

      // fotos dos produtos que só aparecem no histórico
      await this.fillMissingListings(tenantId, connectionId, conn);

      // 4. fretes (comprador/vendedor), cupons e devoluções de todo o período importado
      await this.enrichFinance(tenantId, connectionId, runId, conn, d90, true);

      // 5. últimos ajustes (longos: até 2 mil envios e a fatura do ML, que limita rajadas)
      await this.run(tenantId, runId, { phase: 'finishing', progress: SYNC_PHASE_END.shipping_costs });
      await this.backfillAddresses(tenantId, connectionId, conn, 2000);
      await this.run(tenantId, runId, { progress: 94 });
      await this.backfillPaidFreight(tenantId, connectionId, conn, 2000);
      await this.run(tenantId, runId, { progress: 97 });
      await this.syncBilling(tenantId, connectionId, conn);
      await this.run(tenantId, runId, { progress: 99 });
      await this.db.withTenant(tenantId, (db) => this.sales.refreshListingSalesStats(db, conn.account_id));

      await this.run(tenantId, runId, { status: 'done', progress: 100 });
      this.events.publish({ type: 'marketplace.synced', tenantId, payload: { connectionId } });
    } catch (err) {
      const message = err instanceof MlApiError ? `Mercado Livre respondeu: ${err.message}` : 'Erro inesperado na sincronização';
      await this.run(tenantId, runId, { status: 'failed', error: message }).catch(() => undefined);
      throw err;
    }
  }

  private async importRange(
    tenantId: string,
    connectionId: string,
    runId: string,
    conn: ConnectionRow,
    from: Date,
    to: Date,
    phase: 'orders_recent' | 'orders_history',
  ): Promise<void> {
    const start = PHASE_START[phase];
    const end = SYNC_PHASE_END[phase];
    for (let offset = 0; offset < MAX_OFFSET; offset += ORDERS_PAGE_SIZE) {
      const { token } = await this.accessToken(tenantId, connectionId);
      const page = await this.api.searchOrders(token, conn.ml_user_id, mlDate(from), mlDate(to), offset);
      const orders = page.results.map(mapMlOrder).filter((o) => o !== null);
      await this.db.withTenant(tenantId, async (db) => {
        await this.sales.upsertOrders(db, tenantId, conn.account_id, 'mercado_livre', orders);
        const done = Math.min(1, (offset + page.results.length) / Math.max(1, page.paging.total));
        await this.repo.updateRun(db, runId, { progress: Math.round(start + (end - start) * done), addOrders: orders.length });
      });
      if (page.results.length < ORDERS_PAGE_SIZE || offset + ORDERS_PAGE_SIZE >= page.paging.total) break;
    }
  }

  /**
   * Anúncios: na sincronização completa traz TODOS (ativos + pausados) para o cadastro de SKUs;
   * no ciclo de hora em hora só os pausados (carrossel) e o que faltar de foto.
   */
  private async syncListings(
    tenantId: string,
    connectionId: string,
    runId: string | null,
    conn: ConnectionRow,
    scope: 'all' | 'paused' = 'all',
  ): Promise<void> {
    const start = PHASE_START.listings;
    const span = SYNC_PHASE_END.listings - start;
    const statuses = scope === 'all' ? ['paused', 'active'] : ['paused'];

    const ids: string[] = [];
    for (const status of statuses) {
      let scrollId: string | null = null;
      for (let page = 0; page < MAX_LISTING_PAGES; page++) {
        const { token } = await this.accessToken(tenantId, connectionId);
        const r = await this.api.listingIds(token, conn.ml_user_id, status, scrollId);
        if (!r.ids.length) break;
        ids.push(...r.ids);
        scrollId = r.scrollId;
        if (!scrollId) break;
      }
    }
    // os que estavam pausados na base e não estão mais (reativados/encerrados) também são atualizados
    const known = await this.db.withTenant(tenantId, (db) => this.sales.pausedListingIds(db, conn.account_id));
    const all = [...new Set([...ids, ...known])];
    await this.importListings(tenantId, connectionId, conn, all, async (done) => {
      if (runId) await this.run(tenantId, runId, { progress: Math.round(start + span * 0.9 * done) });
    });
    await this.fillMissingListings(tenantId, connectionId, conn);
  }

  private async fillMissingListings(tenantId: string, connectionId: string, conn: ConnectionRow): Promise<void> {
    const missing = await this.db.withTenant(tenantId, (db) => this.sales.listingsMissing(db, conn.account_id));
    await this.importListings(tenantId, connectionId, conn, missing);
  }

  /** Relê anúncios no ML e atualiza o catálogo local (após uma edição pelo sistema). */
  async refreshListings(tenantId: string, connectionId: string, ids: string[]): Promise<void> {
    const { conn } = await this.accessToken(tenantId, connectionId);
    await this.importListings(tenantId, connectionId, conn, ids);
  }

  /** Busca anúncios em lotes de 20 (multiget) e grava no catálogo. */
  private async importListings(
    tenantId: string,
    connectionId: string,
    conn: ConnectionRow,
    ids: string[],
    onProgress?: (fraction: number) => Promise<void>,
  ): Promise<void> {
    for (let i = 0; i < ids.length; i += 20) {
      const { token } = await this.accessToken(tenantId, connectionId);
      const items = await this.api.items(token, ids.slice(i, i + 20));
      const listings = items.map(mapMlItem);
      // bônus de tarifa: só para quem está em promoção (1 chamada por anúncio com desconto)
      for (const l of listings) {
        if (l.originalPrice === null) continue;
        const promos = await this.api.itemPromotions(token, l.externalId).catch(() => []);
        const b = feeBonusOf(promos, l.originalPrice);
        if (b) {
          l.feeBonus = b.bonus;
          l.promoName = b.name;
        }
      }
      await this.db.withTenant(tenantId, (db) =>
        this.sales.upsertListings(db, tenantId, conn.account_id, 'mercado_livre', listings),
      );
      await onProgress?.(Math.min(1, (i + 20) / ids.length));
    }
  }

  /**
   * Enriquecimento financeiro (regras NVS-WMS): para cada pedido ainda não processado busca o
   * envio (modalidade, custo de tabela → frete comprador/vendedor, rateado em pacote) e os
   * descontos (cupom do vendedor), e recalcula custo/imposto. Um envio é buscado uma vez por pacote.
   */
  private async enrichFinance(
    tenantId: string,
    connectionId: string,
    runId: string | null,
    conn: ConnectionRow,
    since: Date,
    reportProgress: boolean,
    onlyExternalId?: string,
  ): Promise<void> {
    const pending = await this.db.withTenant(tenantId, (db: Queryable) =>
      this.sales.pendingEnrichment(db, conn.account_id, since.toISOString(), 5000, onlyExternalId),
    );
    const start = PHASE_START.shipping_costs;
    const sellerId = Number(conn.ml_user_id);
    const shipmentsDone = new Set<string>();
    let done = 0;
    // concorrência pequena para respeitar o limite de requisições do ML
    const queue = [...pending];
    const worker = async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const { token } = await this.accessToken(tenantId, connectionId);
        const touched: string[] = [next.id];
        const discounts = await this.api.discounts(token, next.externalId);
        const coupon = sellerCoupon(discounts);
        if (next.shippingRef && !shipmentsDone.has(next.shippingRef)) {
          shipmentsDone.add(next.shippingRef);
          const shipment = await this.api.shipment(token, next.shippingRef);
          if (shipment) {
            const costs =
              next.buyerShipping === 0 && (shipment.shipping_option?.cost ?? 0) === 0
                ? await this.api.shipmentCosts(token, next.shippingRef)
                : null;
            const freight = shipmentFreight({
              payments: [{ status: 'approved', shipping_cost: next.buyerShipping }],
              shipment,
              costs,
              sellerId,
            });
            const ids = await this.db.withTenant(tenantId, async (db) => {
              await this.sales.setShipmentAddress(db, next.shippingRef!, shipmentAddress(shipment));
              return this.sales.setShipmentFinance(db, next.shippingRef!, freight);
            });
            touched.push(...ids);
          }
        }
        await this.db.withTenant(tenantId, async (db) => {
          await this.sales.setCoupon(db, next.id, coupon, true);
          await this.sales.recompute(db, [...new Set(touched)]);
        });
        done++;
        if (reportProgress && runId && done % 10 === 0) {
          await this.run(tenantId, runId, { progress: Math.round(start + (SYNC_PHASE_END.shipping_costs - start) * (done / pending.length)) });
        }
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
  }

  /**
   * Troca o frete de tabela pelo frete cobrado de fato (senders.cost, com desconto de reputação) nas vendas
   * dos últimos 90 dias enriquecidas antes dessa regra. Em lotes, em segundo plano.
   */
  async backfillPaidFreight(tenantId: string, connectionId: string, conn: ConnectionRow, limit = 300): Promise<number> {
    const refs = await this.db.withTenant(tenantId, (db) => this.sales.pendingPaidFreight(db, conn.account_id, limit));
    const sellerId = Number(conn.ml_user_id);
    const queue = [...refs];
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const { token } = await this.accessToken(tenantId, connectionId);
        const costs = await this.api.shipmentCosts(token, ref).catch(() => null);
        const paid = costs ? sellerPaidFreight(costs, sellerId) : null;
        const list = typeof costs?.gross_amount === 'number' && costs.gross_amount > 0 ? costs.gross_amount : null;
        await this.db.withTenant(tenantId, async (db) => {
          const ids = await this.sales.setPaidFreight(db, ref, paid, list);
          if (paid !== null) await this.sales.recompute(db, ids);
        });
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return refs.length;
  }

  /**
   * Completa o destino (UF/cidade/CEP) de pedidos antigos, já enriquecidos antes de guardarmos o endereço.
   * Em lotes, em segundo plano, para não pesar no limite de requisições do ML.
   */
  async backfillAddresses(tenantId: string, connectionId: string, conn: ConnectionRow, limit = 400): Promise<number> {
    const refs = await this.db.withTenant(tenantId, (db) => this.sales.pendingAddresses(db, conn.account_id, limit));
    const queue = [...refs];
    const worker = async () => {
      for (let ref = queue.shift(); ref; ref = queue.shift()) {
        const { token } = await this.accessToken(tenantId, connectionId);
        const shipment = await this.api.shipment(token, ref).catch(() => null);
        await this.db.withTenant(tenantId, (db) =>
          this.sales.setShipmentAddress(db, ref, shipment ? shipmentAddress(shipment) : { uf: null, city: null, zip: null }),
        );
      }
    };
    await Promise.all(Array.from({ length: 4 }, worker));
    return refs.length;
  }

  /**
   * Fatura mensal do ML (cobranças, bonificações e o ICMS-DIFAL cobrado). Mês fechado é lido uma vez;
   * o mês em aberto, no máximo 1 vez por dia (recomendação do ML: a informação é estática no dia).
   * Falha aqui não derruba a sincronização (a conta pode não ter permissão de faturamento).
   */
  async syncBilling(tenantId: string, connectionId: string, conn: ConnectionRow): Promise<number> {
    try {
      const { token } = await this.accessToken(tenantId, connectionId);
      const periods = await this.api.billingPeriods(token);
      const known = await this.db.withTenant(tenantId, (db) => this.repo.billingFetched(db, conn.account_id));
      let fetched = 0;
      for (const p of periods) {
        const k = known.get(p.key);
        const closed = (p.period_status ?? '').toUpperCase() === 'CLOSED';
        const fresh = k && (k.status === 'CLOSED' ? true : !closed && Date.now() - k.fetchedAt.getTime() < 20 * 3_600_000);
        if (fresh) continue;
        const s = await this.api.billingSummary(token, p.key);
        await this.db.withTenant(tenantId, (db) =>
          this.repo.saveBilling(db, {
            tenantId,
            accountId: conn.account_id,
            key: p.key,
            dateFrom: s.period?.date_from ?? p.period?.date_from ?? null,
            dateTo: s.period?.date_to ?? p.period?.date_to ?? null,
            status: p.period_status ?? null,
            total: s.bill_includes?.total_amount ?? p.amount ?? null,
            difal: billedDifal(s),
            charges: s.bill_includes?.charges ?? [],
            bonuses: s.bill_includes?.bonuses ?? [],
          }),
        );
        fetched++;
      }
      return fetched;
    } catch (err) {
      this.log.error({ err, tenantId }, 'Mercado Livre: faturamento indisponível');
      return 0;
    }
  }

  // ================= Atualização automática (de hora em hora)
  /**
   * Atualização incremental: pedidos dos últimos 3 dias, anúncios pausados/fotos e fretes.
   * Complementa as notificações (que trazem cada venda na hora) garantindo números consistentes.
   */
  async syncIncremental(tenantId: string, connectionId: string): Promise<void> {
    const runId = await this.db.withTenant(tenantId, async (db) => {
      await this.repo.lockSync(db, connectionId);
      if ((await this.repo.latestRun(db, connectionId))?.status === 'running') return null; // completa em andamento
      if ((await this.repo.latestRun(db, connectionId, 'incremental'))?.status === 'running') return null;
      return this.repo.startRun(db, tenantId, connectionId, 'incremental');
    });
    if (!runId) return;
    try {
      const { conn } = await this.accessToken(tenantId, connectionId);
      const now = new Date();
      const since = new Date(now.getTime() - 3 * DAY);
      await this.importRange(tenantId, connectionId, runId, conn, since, now, 'orders_recent');
      await this.syncListings(tenantId, connectionId, null, conn, 'paused');
      await this.enrichFinance(tenantId, connectionId, null, conn, since, false);
      await this.backfillAddresses(tenantId, connectionId, conn);
      await this.backfillPaidFreight(tenantId, connectionId, conn);
      await this.syncBilling(tenantId, connectionId, conn);
      await this.db.withTenant(tenantId, (db) => this.sales.refreshListingSalesStats(db, conn.account_id));
      await this.run(tenantId, runId, { status: 'done', progress: 100 });
    } catch (err) {
      const message = err instanceof MlApiError ? `Mercado Livre respondeu: ${err.message}` : 'Erro inesperado na atualização';
      await this.run(tenantId, runId, { status: 'failed', error: message }).catch(() => undefined);
      throw err;
    }
  }

  /** Contas ativas de todas as empresas (para agendadores de outros módulos, ex.: devoluções). */
  async activeConnections(): Promise<{ tenantId: string; connectionId: string }[]> {
    const out: { tenantId: string; connectionId: string }[] = [];
    for (const tenantId of await this.repo.connectedTenants()) {
      const conns = await this.db.withTenant(tenantId, (db) => this.repo.connections(db));
      for (const c of conns.filter((x) => x.status === 'active')) out.push({ tenantId, connectionId: c.id });
    }
    return out;
  }

  /** Reserva um ciclo de agendador (só uma instância processa cada horário). */
  claimSlot(name: string, slot: Date): Promise<boolean> {
    return this.repo.claimSlot(name, slot);
  }

  /** Um ciclo do agendador. Retorna false se outra instância já processou esta hora. */
  async hourlyTick(now = new Date()): Promise<boolean> {
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    if (!(await this.repo.claimSlot('ml_hourly_sync', slot))) return false;
    for (const tenantId of await this.repo.connectedTenants()) {
      const conns = await this.db.withTenant(tenantId, (db) => this.repo.connections(db));
      for (const c of conns.filter((x) => x.status === 'active')) {
        // uma conta por vez: respeita o limite de requisições do ML e não sobrecarrega o banco
        await this.syncIncremental(tenantId, c.id).catch((err) =>
          this.log.error({ err, tenantId }, 'Mercado Livre: atualização automática falhou'),
        );
      }
    }
    return true;
  }

  /** Agenda os ciclos no início de cada hora. Retorna a função para parar. */
  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      const next = Math.ceil((now + 1) / 3_600_000) * 3_600_000 + 15_000; // hh:00:15
      timer = setTimeout(() => {
        this.hourlyTick().catch((err) => this.log.error({ err }, 'Mercado Livre: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    this.log.info({}, 'Mercado Livre: atualização automática de hora em hora ativa');
    return () => clearTimeout(timer);
  }

  // ================= Notificações (tempo real)
  /**
   * Entrada do webhook: descarta repetidas (mesmo recurso em 30s), limita a fila e processa com no máximo
   * 4 em paralelo. Assim um flood de avisos não vira um flood de chamadas ao ML e ao banco.
   */
  enqueueNotification(n: MlNotification): boolean {
    const key = `${n.topic}|${n.resource}|${n.user_id}`;
    const now = Date.now();
    if ((this.notifSeen.get(key) ?? 0) > now) return false;
    if (this.notifSeen.size > 10_000) {
      for (const [k, exp] of this.notifSeen) if (exp <= now) this.notifSeen.delete(k);
    }
    this.notifSeen.set(key, now + 30_000);
    if (this.notifQueue.length >= 2_000) return false;
    this.notifQueue.push(n);
    this.drainNotifications();
    return true;
  }

  private drainNotifications() {
    while (this.notifWorkers < 4 && this.notifQueue.length) {
      const n = this.notifQueue.shift()!;
      this.notifWorkers++;
      const job = this.handleNotification(n)
        .catch((err) => this.log.error({ err }, 'Mercado Livre: notificação falhou'))
        .finally(() => {
          this.notifWorkers--;
          this.inflight.delete(job);
          this.drainNotifications();
        });
      this.inflight.add(job);
    }
  }

  async handleNotification(n: MlNotification): Promise<void> {
    if (String(n.application_id ?? '') !== this.opts.clientId) return; // não é do nosso app
    if (!n.user_id || !n.resource) return;
    const isOrder = n.topic === 'orders_v2' || n.topic === 'orders';
    const isItem = n.topic === 'items';
    if (!isOrder && !isItem) return;

    const tenantId = await this.repo.tenantOf(String(n.user_id));
    if (!tenantId) return;
    const conn = await this.db.withTenant(tenantId, (db) => this.repo.connectionByMlUser(db, String(n.user_id)));
    if (!conn || conn.status !== 'active') return;

    if (isItem) {
      // anúncio pausado/reativado/alterado: atualiza o catálogo na hora
      const itemId = n.resource.split('/').filter(Boolean).pop();
      if (!itemId || !/^[A-Z]{3}\d+$/.test(itemId)) return;
      await this.importListings(tenantId, conn.id, conn, [itemId]);
      return;
    }

    const orderId = n.resource.split('/').filter(Boolean).pop();
    if (!orderId || !/^\d+$/.test(orderId)) return;
    // o ML costuma reenviar a mesma notificação várias vezes seguidas: processa uma por vez
    const key = `${tenantId}:${orderId}`;
    if (this.processingOrders.has(key)) return;
    this.processingOrders.add(key);
    try {
      await this.processOrderNotification(tenantId, conn, orderId);
    } finally {
      this.processingOrders.delete(key);
    }
  }

  private async processOrderNotification(tenantId: string, conn: ConnectionRow, orderId: string): Promise<void> {
    const { token } = await this.accessToken(tenantId, conn.id);
    const order: MlOrder = await this.api.order(token, orderId);
    const mapped = mapMlOrder(order);
    if (!mapped) return;
    await this.db.withTenant(tenantId, (db) =>
      this.sales.upsertOrders(db, tenantId, conn.account_id, 'mercado_livre', [mapped]),
    );
    // fretes/cupom só deste pedido (força o recálculo: status/valores podem ter mudado)
    await this.enrichFinance(tenantId, conn.id, null, conn, new Date(Date.now() - 400 * DAY), false, orderId);
    this.log.info({ tenantId, orderId }, 'Mercado Livre: pedido atualizado por notificação');
  }
}
