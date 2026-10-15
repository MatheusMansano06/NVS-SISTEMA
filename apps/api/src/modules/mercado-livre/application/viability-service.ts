import type { ViabilityDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { typeLabel } from '../domain/listing-margin.js';
import { ageInDays, monthlyVisits, salesPerDay } from '../domain/viability.js';
import type { MlRawApi } from '../infrastructure/ml-api.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const CACHE_TTL = 6 * 3600; // dado público do anúncio: o mesmo para qualquer empresa
const VISIT_DAYS = 180;

interface MlItemLite {
  id: string;
  title: string;
  permalink?: string | null;
  thumbnail?: string | null;
  price?: number | null;
  date_created?: string | null;
  sold_quantity?: number | null;
  catalog_listing?: boolean | null;
  listing_type_id?: string | null;
  available_quantity?: number | null;
  seller_id?: number | null;
  shipping?: { free_shipping?: boolean; logistic_type?: string | null } | null;
}

interface MlVisitsWindow {
  total_visits?: number;
  results?: { date: string; total: number }[];
}

class FeatureLockedError extends AppError {
  constructor() {
    super('O Estudo de Viabilidade ainda não está liberado para a sua empresa.', 'FEATURE_LOCKED', 403);
  }
}

/** Estudo de viabilidade de qualquer anúncio do ML (data, vendas, tipo, visitas) com o token da empresa. */
export class ViabilityService {
  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi,
    private readonly cache: Cache,
  ) {}

  async analyze(tenantId: string, rawId: string): Promise<ViabilityDto> {
    await this.ensureFeature(tenantId);
    const id = rawId.toUpperCase().replace('-', '');
    const key = `viability:${id}`;
    const hit = await this.cache.get<ViabilityDto>(key);
    if (hit) return hit;

    const token = await this.anyToken(tenantId);
    const unavailable: string[] = [];
    // aceita o ID do anúncio ou do produto de catálogo (/p/MLB…): no produto, usa o anúncio que ganha a vitrine
    let item = await this.api.rawGet<MlItemLite>(token, `/items/${id}`);
    if (!item) {
      const product = await this.api.rawGet<{ buy_box_winner?: { item_id?: string } | null }>(token, `/products/${id}`);
      const winner = product?.buy_box_winner?.item_id;
      if (winner) item = await this.api.rawGet<MlItemLite>(token, `/items/${winner}`);
    }
    if (!item) throw new AppError('Anúncio não encontrado ou não liberado pelo Mercado Livre.', 'NOT_FOUND', 404);

    const [visits, seller] = await Promise.all([
      this.api.rawGet<MlVisitsWindow>(token, `/items/${item.id}/visits/time_window?last=${VISIT_DAYS}&unit=day`),
      item.seller_id
        ? this.api.rawGet<{ nickname?: string; seller_reputation?: { level_id?: string | null } }>(token, `/users/${item.seller_id}`)
        : Promise.resolve(null),
    ]);
    if (!visits) unavailable.push('visitas');
    if (item.sold_quantity == null) unavailable.push('vendas');

    const age = ageInDays(item.date_created, new Date());
    const daily = (visits?.results ?? []).map((r) => ({ date: r.date.slice(0, 10), total: r.total ?? 0 }));
    const dto: ViabilityDto = {
      itemId: item.id,
      title: item.title,
      permalink: item.permalink ?? null,
      thumbnail: item.thumbnail ?? null,
      price: item.price ?? null,
      createdAt: item.date_created ?? null,
      ageDays: age,
      soldQuantity: item.sold_quantity ?? null,
      salesPerDay: salesPerDay(item.sold_quantity, age),
      catalog: item.catalog_listing ?? null,
      listingType: typeLabel(item.listing_type_id ?? null),
      freeShipping: item.shipping?.free_shipping ?? null,
      logisticType: item.shipping?.logistic_type ?? null,
      availableQuantity: item.available_quantity ?? null,
      seller: item.seller_id
        ? { id: item.seller_id, nickname: seller?.nickname ?? null, reputation: seller?.seller_reputation?.level_id ?? null }
        : null,
      visits: visits ? { total: visits.total_visits ?? daily.reduce((s, d) => s + d.total, 0), daily, monthly: monthlyVisits(daily) } : null,
      unavailable,
      fetchedAt: new Date().toISOString(),
    };
    await this.cache.set(key, dto, CACHE_TTL);
    return dto;
  }

  /** A extensão chama a API direto, então o "em breve" do plano precisa valer aqui também. */
  private async ensureFeature(tenantId: string): Promise<void> {
    const r = await this.db.query<{ features: string[] }>('SELECT features FROM tenants WHERE id = $1', [tenantId]);
    if (!r.rows[0]?.features.includes('viabilidade')) throw new FeatureLockedError();
  }

  /** Token de qualquer conta ativa da empresa (anúncio de terceiro é igual para qualquer conta). */
  private async anyToken(tenantId: string): Promise<string> {
    const status = await this.ml.status(tenantId);
    const c = status.connections.find((x) => x.status === 'active');
    if (!c) throw new AppError('Conecte uma conta do Mercado Livre para usar o Estudo de Viabilidade.', 'LISTING_BLOCKED', 409);
    return (await this.ml.accessToken(tenantId, c.id)).token;
  }
}
