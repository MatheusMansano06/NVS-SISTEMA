import {
  PRICED_PROMOTION_TYPES,
  type PromotionCandidateDto,
  type PromotionCandidatesDto,
  type PromotionDto,
  type PromotionsDto,
} from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { AppError, NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { MlApiError, type MlApi, type MlPromotionItem } from '../infrastructure/ml-api.js';
import { PgListingRepository, toNumber, type ListingRow } from '../infrastructure/pg-listing-repository.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const PROMOS_TTL = 300; // campanhas mudam pouco ao longo do dia
const CANDIDATES_TTL = 120;
const MAX_CANDIDATE_PAGES = 10; // até 500 anúncios elegíveis por campanha
const priced = new Set<string>(PRICED_PROMOTION_TYPES);

/**
 * Central de Promoção: campanhas abertas de cada conta do ML da empresa e os anúncios elegíveis que
 * ainda estão fora delas. Respostas do ML ficam em cache curto por empresa (e são invalidadas ao inscrever).
 */
export class PromotionService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgListingRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
    private readonly cache: Cache,
  ) {}

  async list(tenantId: string, refresh = false): Promise<PromotionsDto> {
    const key = `ml:promos:${tenantId}`;
    if (!refresh) {
      const hit = await this.cache.get<PromotionsDto>(key);
      if (hit) return hit;
    }
    const status = await this.ml.status(tenantId);
    const active = status.connections.filter((c) => c.status === 'active');
    const items: PromotionDto[] = [];
    for (const c of active) {
      const { token, conn } = await this.ml.accessToken(tenantId, c.id);
      const promos = await this.wrap(() => this.api.promotions(token, conn.ml_user_id));
      for (const p of promos) {
        const st = (p.status ?? '').toLowerCase();
        // só as que ainda aceitam inscrição (em andamento ou agendadas)
        if (st !== 'started' && st !== 'pending') continue;
        items.push({
          id: p.id,
          type: p.type,
          name: p.name || p.id,
          status: st,
          startDate: p.start_date ?? null,
          finishDate: p.finish_date ?? null,
          requiresPrice: priced.has(p.type),
          connectionId: c.id,
          account: c.nickname,
        });
      }
    }
    // em andamento primeiro; depois as que terminam antes
    items.sort((a, b) => (a.status === b.status ? (a.finishDate ?? '9').localeCompare(b.finishDate ?? '9') : a.status === 'started' ? -1 : 1));
    const dto = { items, connected: active.length > 0 };
    await this.cache.set(key, dto, PROMOS_TTL);
    return dto;
  }

  async candidates(tenantId: string, connectionId: string, promotionId: string, type: string, refresh = false): Promise<PromotionCandidatesDto> {
    const key = this.candidatesKey(tenantId, connectionId, promotionId);
    if (!refresh) {
      const hit = await this.cache.get<PromotionCandidatesDto>(key);
      if (hit) return hit;
    }
    const { token } = await this.token(tenantId, connectionId);
    const raw: MlPromotionItem[] = [];
    let after: string | null = null;
    for (let page = 0; page < MAX_CANDIDATE_PAGES; page++) {
      const r = await this.wrap(() => this.api.promotionCandidates(token, promotionId, type, after));
      raw.push(...r.results);
      after = r.searchAfter;
      if (!after || !r.results.length) break;
    }
    // título, foto, SKU, custo e tarifa/frete vêm do banco local (sem 1 chamada ao ML por anúncio)
    const { rows, taxPct } = await this.db.withTenant(tenantId, async (db) => ({
      rows: await this.repo.byIds(db, raw.map((r) => r.id)),
      taxPct: await this.repo.taxPct(db),
    }));
    const byId = new Map(rows.map((r) => [r.external_id, r]));
    const items: PromotionCandidateDto[] = raw.map((r) => {
      const l = byId.get(r.id);
      return {
        id: r.id,
        title: l?.title ?? r.id,
        sku: l?.sku ?? null,
        pictureUrl: l?.picture_url ?? null,
        permalink: l?.permalink ?? null,
        originalPrice: r.original_price ?? toNumber(l?.price ?? null),
        price: r.price ?? null,
        suggestedPrice: r.suggested_discounted_price ?? null,
        minPrice: r.min_discounted_price ?? null,
        maxPrice: r.max_discounted_price ?? null,
        meliPct: r.meli_percentage ?? null,
        sellerPct: r.seller_percentage ?? null,
        cost: toNumber(l?.custo_unit ?? null),
        ...(l ? feeAndFreight(l) : { feeRate: null, freight: null }),
        taxPct,
      };
    });
    const dto = { items, total: items.length };
    await this.cache.set(key, dto, CANDIDATES_TTL);
    return dto;
  }

  async enroll(
    tenantId: string,
    connectionId: string,
    promotionId: string,
    itemId: string,
    input: { promotionType: string; dealPrice?: number },
  ): Promise<{ ok: true }> {
    if (priced.has(input.promotionType) && !input.dealPrice) {
      throw new ValidationError('Esta promoção exige um preço de oferta.');
    }
    const { token } = await this.token(tenantId, connectionId);
    await this.wrap(() =>
      this.api.enrollPromotion(token, itemId, {
        promotion_id: promotionId,
        promotion_type: input.promotionType,
        ...(priced.has(input.promotionType) ? { deal_price: input.dealPrice } : {}),
      }),
    );
    await this.cache.del(this.candidatesKey(tenantId, connectionId, promotionId));
    return { ok: true };
  }

  private candidatesKey(tenantId: string, connectionId: string, promotionId: string) {
    return `ml:promo-cand:${tenantId}:${connectionId}:${promotionId}`;
  }

  /** Token da conexão — que precisa ser desta empresa (o RLS garante na leitura). */
  private async token(tenantId: string, connectionId: string) {
    const status = await this.ml.status(tenantId);
    const c = status.connections.find((x) => x.id === connectionId);
    if (!c) throw new NotFoundError('Conta do Mercado Livre não encontrada');
    if (c.status !== 'active') throw new AppError('Reconecte a conta do Mercado Livre.', 'LISTING_BLOCKED', 409);
    return this.ml.accessToken(tenantId, c.id);
  }

  private async wrap<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MlApiError) {
        throw new AppError(`Mercado Livre: ${err.message}`, 'MARKETPLACE_ERROR', err.status === 401 ? 401 : 502);
      }
      throw err;
    }
  }
}

/** Tarifa (fração do preço) e frete: salvos da última consulta ao vivo, senão média das vendas. */
export function feeAndFreight(l: ListingRow): { feeRate: number | null; freight: number | null } {
  const price = toNumber(l.price);
  const saved = l.pricing_price !== null && Number(l.pricing_price) > 0 && l.fee_amount !== null;
  if (saved) return { feeRate: Number(l.fee_amount) / Number(l.pricing_price), freight: toNumber(l.freight_cost) };
  const fee = toNumber(l.avg_fee);
  return { feeRate: fee !== null && price ? fee / price : null, freight: toNumber(l.avg_freight) };
}
