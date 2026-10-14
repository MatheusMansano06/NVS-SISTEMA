import type { FastifyBaseLogger } from 'fastify';
import type { ReturnSyncDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { MlIntegrationService, MlRawApi } from '../../mercado-livre/index.js';
import { normalizeClaim, normalizeNotDelivered, type ReturnRecord } from '../domain/normalize.js';
import type { PgReturnsRepository } from '../infrastructure/pg-returns-repository.js';
import { ReturnsEnrichment, type MlGet } from './returns-enrichment.js';
import { SyncProgress } from './sync-progress.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const MAX_OFFSET = 9_900;
const TASKS = ['mercado_livre', 'fotos_anuncios', 'logistica_venda', 'mediacao_origem', 'mediacao_atuacao', 'fatura_ml'];
const TICK_MS = 10 * 60_000;
/** Espera entre tentativas quando o ML responde 429 (muitas requisições): não pula a reclamação, espera e repete. */
const BACKOFF_MS = [2_000, 4_000, 8_000, 15_000, 30_000];
/** Pausa entre reclamações: ~5 chamadas cada, sem estourar o limite do ML. */
const PACE_MS = 150;
const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
const tooMany = (err: unknown) => (err as { status?: number })?.status === 429;

/** Repete a chamada enquanto o ML disser 429; qualquer outro erro sobe na hora. */
export async function patient<T>(fn: () => Promise<T>, wait: (ms: number) => Promise<void> = sleep): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!tooMany(err) || attempt >= BACKOFF_MS.length) throw err;
      await wait(BACKOFF_MS[attempt]!);
    }
  }
}
/** Varredura do dia (23h em São Paulo = 02h UTC): toda reclamação aberta + últimos 2 dias. */
const SWEEP_UTC_HOUR = 2;

/**
 * Sincronização das devoluções do ML (portada de central/mercado_livre/sincronizar.py): reclamações com devolução
 * atualizadas nos últimos `days` + (opcional) toda reclamação ainda aberta, de qualquer data — as antigas sem movimento
 * não aparecem na janela de datas e sumiriam da operação. Mais os pacotes não entregues que voltaram.
 */
export class ReturnsSync {
  /** rules_engine_triage por motivo do ML (muda raramente: cache do processo). */
  private readonly triage = new Map<string, string | null>();
  private readonly running = new Set<string>();
  readonly progress = new SyncProgress();
  readonly enrichment: ReturnsEnrichment;

  constructor(
    private readonly db: Database,
    private readonly repo: PgReturnsRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi,
    private readonly log: FastifyBaseLogger,
  ) {
    this.enrichment = new ReturnsEnrichment(db);
  }

  isRunning(tenantId: string) {
    return this.running.has(tenantId);
  }

  /**
   * Todas as contas ML ativas da empresa: reclamações e, depois, o que o B.I consulta uma vez por devolução (Full x
   * orgânica, quem abriu a mediação, se a empresa atuou) e a fatura. Uma rodada por empresa de cada vez; cada tarefa
   * que falha fica registrada e não segura as outras.
   */
  async syncTenant(
    tenantId: string,
    opts: { days: number; allOpen: boolean; sweep?: boolean; redo?: string; after?: () => Promise<void> },
  ): Promise<ReturnSyncDto> {
    if (this.running.has(tenantId)) return { claims: 0, saved: 0, failures: 0 };
    this.running.add(tenantId);
    const tasks = opts.redo ? ['refazer_ml', 'refazer_fatura', 'fechamento'] : TASKS;
    this.progress.start(tenantId, tasks, { sweep: opts.sweep, redoing: opts.redo ?? null });
    try {
      const st = await this.ml.status(tenantId);
      const total: ReturnSyncDto = { claims: 0, saved: 0, failures: 0 };
      const conns = st.connections.filter((x) => x.status === 'active');
      this.progress.task(tenantId, tasks[0]!);
      let erro: string | null = conns.length ? null : 'Mercado Livre não conectado';
      for (const [i, c] of conns.entries()) {
        try {
          const r = await this.syncConnection(tenantId, c.id, opts, (f) => this.progress.partial(tenantId, (i + f) / conns.length));
          total.claims += r.claims;
          total.saved += r.saved;
          total.failures += r.failures;
        } catch (err) {
          erro = (err as Error).message.slice(0, 200);
          this.log.warn({ err, tenantId }, 'Devoluções: conta do ML falhou na sincronização');
        }
      }
      this.progress.record(tenantId, 'mercado_livre', { ok: !erro, erro, resultado: { ...total } });
      for (const c of conns) {
        const { conn } = await this.ml.accessToken(tenantId, c.id).catch(() => ({ conn: null }));
        if (!conn) continue;
        const get: MlGet = (path) => patient(async () => this.api.rawGet((await this.ml.accessToken(tenantId, c.id)).token, path));
        await this.enrich(tenantId, conn.account_id, get, opts.redo);
      }
      if (opts.after) {
        this.progress.task(tenantId, 'fechamento');
        await opts.after();
      }
      await this.db.withTenant(tenantId, (db) =>
        db.query(
          `INSERT INTO return_sync_state (tenant_id, last_sync, last_result) VALUES ($1, now(), $2)
           ON CONFLICT (tenant_id) DO UPDATE SET last_sync = now(), last_result = EXCLUDED.last_result`,
          [tenantId, JSON.stringify(total)],
        ),
      );
      return total;
    } finally {
      this.progress.finish(tenantId);
      this.running.delete(tenantId);
    }
  }

  private async enrich(tenantId: string, accountId: string, get: MlGet, redo?: string) {
    const run = async (task: string, fn: () => Promise<Record<string, unknown>>) => {
      this.progress.task(tenantId, task);
      try {
        const r = await fn();
        this.progress.record(tenantId, task, { ok: !r.erro, erro: (r.erro as string) ?? null, resultado: r });
      } catch (err) {
        this.progress.record(tenantId, task, { ok: false, erro: (err as Error).message.slice(0, 200) });
      }
    };
    const part = (f: number) => this.progress.partial(tenantId, f);
    if (redo) {
      await run('refazer_fatura', () => this.enrichment.billing(tenantId, get, part, { only: redo }));
      return;
    }
    await run('fotos_anuncios', () => this.enrichment.pictures(tenantId, get, part) as never);
    await run('logistica_venda', () => this.enrichment.logistics(tenantId, accountId, get, part) as never);
    await run('mediacao_origem', () => this.enrichment.mediationOrigin(tenantId, accountId, get, part) as never);
    await run('mediacao_atuacao', () => this.enrichment.mediationActions(tenantId, accountId, get, part) as never);
    await run('fatura_ml', () => this.enrichment.billing(tenantId, get, part));
  }

  async syncConnection(
    tenantId: string,
    connectionId: string,
    opts: { days: number; allOpen: boolean },
    onProgress: (fraction: number) => void = () => undefined,
  ): Promise<ReturnSyncDto> {
    const since = new Date(Date.now() - opts.days * 86_400_000).toISOString().replace('Z', '+00:00');
    const out: ReturnSyncDto = { claims: 0, saved: 0, failures: 0 };
    const { conn } = await this.ml.accessToken(tenantId, connectionId);
    const get = <T>(path: string) => patient(async () => this.api.rawGet<T>((await this.ml.accessToken(tenantId, connectionId)).token, path));

    // o ML não aceita só vendedor + data: exige um filtro "de verdade", então busca por status
    for (const status of ['opened', 'closed'] as const) {
      const dateFilter = status === 'opened' && opts.allOpen ? '' : `&range=last_updated:after:${encodeURIComponent(since)}`;
      let offset = 0;
      let total = 1;
      while (offset < Math.min(total, MAX_OFFSET)) {
        const page = await get<{ paging: { total: number }; data: Json[] }>(
          `/post-purchase/v1/claims/search?players.user_id=${conn.ml_user_id}&players.role=respondent&status=${status}${dateFilter}&sort=last_updated:desc&limit=100&offset=${offset}`,
        );
        if (!page) break;
        total = page.paging?.total ?? 0;
        offset += 100;
        onProgress((status === 'opened' ? 0 : 0.5) + Math.min(1, offset / Math.max(1, Math.min(total, MAX_OFFSET))) / 2);
        const records: ReturnRecord[] = [];
        for (const claim of page.data ?? []) {
          await sleep(PACE_MS);
          try {
            const ret = await get<Json>(`/post-purchase/v2/claims/${claim.id}/returns`);
            if (!ret) continue; // reclamação sem devolução física é mediação pura (fora desta central)
            records.push(
              normalizeClaim({
                claim,
                ret,
                cost: await get<Json>(`/post-purchase/v1/claims/${claim.id}/charges/return-cost`),
                reputation: await get<Json>(`/post-purchase/v1/claims/${claim.id}/affects-reputation`),
                triage: await this.triageOf(claim.reason_id, get),
                order: claim.resource === 'order' ? await get<Json>(`/orders/${claim.resource_id}`) : null,
                // a revisão (vendável / sem condição / descarte) só existe depois que o produto chegou
                review: ret.status === 'delivered' ? await get<Json>(`/post-purchase/v1/returns/${ret.id}/reviews`) : null,
              }),
            );
          } catch (err) {
            // uma reclamação inacessível ou fora do padrão não pode travar as outras
            out.failures++;
            this.log.warn({ err, tenantId, claim: claim?.id }, 'Devoluções: reclamação ignorada');
          }
        }
        // grava a cada página: uma carga longa que cair no meio não perde o que já veio
        await this.db.withTenant(tenantId, async (db) => {
          for (const r of records) await this.repo.upsert(db, tenantId, conn.account_id, r);
        });
        out.saved += records.length;
      }
      out.claims += Math.min(total, MAX_OFFSET);
    }

    // pacote não entregue que voltou: não abre reclamação. Janela de 60 dias (ou a da carga, se maior), todas as páginas
    const from = new Date(Date.now() - Math.max(60, opts.days) * 86_400_000).toISOString().replace('Z', '+00:00');
    const notDelivered: ReturnRecord[] = [];
    for (let offset = 0, total = 1; offset < Math.min(total, MAX_OFFSET); offset += 50) {
      const orders = await get<{ results?: Json[]; paging?: { total: number } }>(
        `/orders/search?seller=${conn.ml_user_id}&shipping.substatus=returned&order.date_created.from=${encodeURIComponent(from)}&sort=date_desc&limit=50&offset=${offset}`,
      );
      if (!orders) break;
      total = orders.paging?.total ?? 0;
      notDelivered.push(...(orders.results ?? []).filter((o) => o.shipping?.id).map(normalizeNotDelivered));
      if (!(orders.results ?? []).length) break;
    }
    await this.db.withTenant(tenantId, async (db) => {
      for (const r of notDelivered) await this.repo.upsert(db, tenantId, conn.account_id, r);
    });
    out.saved += notDelivered.length;
    return out;
  }

  private async triageOf(reasonId: string | undefined, get: <T>(path: string) => Promise<T | null>): Promise<string | null> {
    if (!reasonId) return null;
    if (!this.triage.has(reasonId)) {
      const r = await get<Json>(`/post-purchase/v1/claims/reasons/${encodeURIComponent(reasonId)}`);
      this.triage.set(reasonId, r?.settings?.rules_engine_triage?.[0] ?? null);
    }
    return this.triage.get(reasonId) ?? null;
  }

  /**
   * A cada 10 min: o incremental leve (últimas 3 h). Em hh:20, os últimos 2 dias; e 1x por dia (23h em São Paulo) a
   * varredura: toda reclamação aberta, de qualquer data — as antigas sem movimento não aparecem na janela de datas.
   */
  async tick(now = new Date()): Promise<void> {
    const slot = new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS);
    if (!(await this.ml.claimSlot('returns_sync', slot))) return;
    const minute = slot.getUTCMinutes();
    const sweep = minute === 20 && slot.getUTCHours() === SWEEP_UTC_HOUR;
    const opts = minute === 20 ? { days: 2, allOpen: sweep || slot.getUTCHours() % 6 === 0, sweep } : { days: 0.125, allOpen: false };
    const tenants = [...new Set((await this.ml.activeConnections()).map((c) => c.tenantId))];
    for (const tenantId of tenants) {
      await this.syncTenant(tenantId, opts).catch((err) => this.log.error({ err, tenantId }, 'Devoluções: sincronização falhou'));
    }
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      // próximo múltiplo de 10 min (+30 s, fora do pico da atualização das vendas em hh:00)
      const next = Math.floor(now / TICK_MS) * TICK_MS + TICK_MS + 30_000;
      timer = setTimeout(() => {
        this.tick().catch((err) => this.log.error({ err }, 'Devoluções: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }
}
