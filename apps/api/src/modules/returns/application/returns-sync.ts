import type { FastifyBaseLogger } from 'fastify';
import type { ReturnSyncDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { MlIntegrationService, MlRawApi } from '../../mercado-livre/index.js';
import { normalizeClaim, normalizeNotDelivered, type ReturnRecord } from '../domain/normalize.js';
import type { PgReturnsRepository } from '../infrastructure/pg-returns-repository.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
const MAX_OFFSET = 9_900;

/**
 * Sincronização das devoluções do ML (portada de central/mercado_livre/sincronizar.py): reclamações com devolução
 * atualizadas nos últimos `days` + (opcional) toda reclamação ainda aberta, de qualquer data — as antigas sem movimento
 * não aparecem na janela de datas e sumiriam da operação. Mais os pacotes não entregues que voltaram.
 */
export class ReturnsSync {
  /** rules_engine_triage por motivo do ML (muda raramente: cache do processo). */
  private readonly triage = new Map<string, string | null>();
  private readonly running = new Set<string>();

  constructor(
    private readonly db: Database,
    private readonly repo: PgReturnsRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi,
    private readonly log: FastifyBaseLogger,
  ) {}

  /** Todas as contas ML ativas da empresa. Uma sincronização por empresa de cada vez. */
  async syncTenant(tenantId: string, opts: { days: number; allOpen: boolean }): Promise<ReturnSyncDto> {
    if (this.running.has(tenantId)) return { claims: 0, saved: 0, failures: 0 };
    this.running.add(tenantId);
    try {
      const st = await this.ml.status(tenantId);
      const total: ReturnSyncDto = { claims: 0, saved: 0, failures: 0 };
      for (const c of st.connections.filter((x) => x.status === 'active')) {
        const r = await this.syncConnection(tenantId, c.id, opts);
        total.claims += r.claims;
        total.saved += r.saved;
        total.failures += r.failures;
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
      this.running.delete(tenantId);
    }
  }

  async syncConnection(tenantId: string, connectionId: string, opts: { days: number; allOpen: boolean }): Promise<ReturnSyncDto> {
    const since = new Date(Date.now() - opts.days * 86_400_000).toISOString().replace('Z', '+00:00');
    const out: ReturnSyncDto = { claims: 0, saved: 0, failures: 0 };
    const { conn } = await this.ml.accessToken(tenantId, connectionId);
    const get = async <T>(path: string) => this.api.rawGet<T>((await this.ml.accessToken(tenantId, connectionId)).token, path);

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
        const records: ReturnRecord[] = [];
        for (const claim of page.data ?? []) {
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

    // pacote não entregue que voltou: não abre reclamação (janela de 60 dias)
    const from = new Date(Date.now() - 60 * 86_400_000).toISOString().replace('Z', '+00:00');
    const orders = await get<{ results?: Json[] }>(
      `/orders/search?seller=${conn.ml_user_id}&shipping.substatus=returned&order.date_created.from=${encodeURIComponent(from)}&sort=date_desc&limit=50`,
    );
    const notDelivered = (orders?.results ?? []).filter((o) => o.shipping?.id).map(normalizeNotDelivered);
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

  /** De hora em hora: últimos 2 dias; a cada 6 h também toda reclamação ainda aberta. */
  async hourlyTick(now = new Date()): Promise<void> {
    const slot = new Date(now);
    slot.setUTCMinutes(0, 0, 0);
    if (!(await this.ml.claimSlot('returns_hourly_sync', slot))) return;
    const allOpen = slot.getUTCHours() % 6 === 0;
    const tenants = [...new Set((await this.ml.activeConnections()).map((c) => c.tenantId))];
    for (const tenantId of tenants) {
      await this.syncTenant(tenantId, { days: 2, allOpen }).catch((err) => this.log.error({ err, tenantId }, 'Devoluções: sincronização falhou'));
    }
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      // próximo hh:20 (fora do pico da atualização das vendas, que roda em hh:00)
      let next = Math.floor(now / 3_600_000) * 3_600_000 + 20 * 60_000;
      if (next <= now) next += 3_600_000;
      timer = setTimeout(() => {
        this.hourlyTick().catch((err) => this.log.error({ err }, 'Devoluções: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }
}
