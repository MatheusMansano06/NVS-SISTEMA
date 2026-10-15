import type { ViabilityAccuracyDto, ViabilityDto, ViabilityLiteDto } from '@nvs/shared';
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { AppError } from '../../../shared/kernel/errors.js';
import { typeLabel } from '../domain/listing-margin.js';
import { ageInDays, estimateError, estimateTime, mlbNumber, monthlyVisits, prepareAnchors, salesPerDay, type IdAnchor } from '../domain/viability.js';
import type { MlRawApi } from '../infrastructure/ml-api.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const CACHE_TTL = 6 * 3600; // dado público do anúncio: o mesmo para qualquer empresa
const VISIT_DAYS = 150; // máximo que o ML aceita na janela diária de visitas
const ANCHORS_TTL = 6 * 3600;
const MULTIGET = 20; // limite do ML por chamada de /items?ids=
export const MAX_BATCH = 60;

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

/** Consulta opcional ao ML: qualquer erro (janela inválida, limite etc.) vira "sem dado", sem derrubar o estudo. */
const optional = <T>(p: Promise<T | null>): Promise<T | null> => p.catch(() => null);

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
    private readonly log?: Pick<FastifyBaseLogger, 'warn'>,
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
    if (!item) {
      // anúncio de outro vendedor: o ML recusa /items (403). Tenta os dados que ele ainda libera; vendas e tipo a extensão lê da página
      const dto = await this.thirdParty(tenantId, token, id);
      if (!dto) throw new AppError('Anúncio não encontrado ou não liberado pelo Mercado Livre.', 'NOT_FOUND', 404);
      await this.cache.set(key, dto, CACHE_TTL);
      return dto;
    }

    const [visits, seller] = await Promise.all([
      optional(this.api.rawGet<MlVisitsWindow>(token, `/items/${item.id}/visits/time_window?last=${VISIT_DAYS}&unit=day`)),
      item.seller_id
        ? optional(this.api.rawGet<{ nickname?: string; seller_reputation?: { level_id?: string | null } }>(token, `/users/${item.seller_id}`))
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
      createdAtEstimated: false,
      fromApi: true,
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

  /**
   * Etiquetas da busca: vários anúncios de uma vez (multiget do ML, 20 por chamada), sem visitas.
   * ID que o ML não devolver vem como null.
   */
  async analyzeMany(tenantId: string, rawIds: string[]): Promise<Record<string, ViabilityLiteDto | null>> {
    await this.ensureFeature(tenantId);
    const ids = [...new Set(rawIds.map((i) => i.toUpperCase().replace('-', '')))].slice(0, MAX_BATCH);
    const out: Record<string, ViabilityLiteDto | null> = {};
    const missing: string[] = [];
    for (const id of ids) {
      const hit = await this.cache.get<ViabilityLiteDto>(`viability-lite:${id}`);
      if (hit) out[id] = hit;
      else missing.push(id);
    }
    if (missing.length) {
      const token = await this.anyToken(tenantId);
      const now = new Date();
      for (let i = 0; i < missing.length; i += MULTIGET) {
        const chunk = missing.slice(i, i + MULTIGET);
        const res = await this.api.rawGet<{ code: number; body: MlItemLite }[]>(token, `/items?ids=${chunk.join(',')}`);
        for (const r of res ?? []) {
          if (r.code !== 200 || !r.body?.id) {
            // o ML pode recusar anúncio de outro vendedor: registra o motivo para entendermos o bloqueio
            this.log?.warn({ code: r.code, body: r.body }, 'Viabilidade: ML recusou anúncio no lote');
            continue;
          }
          const lite = toLite(r.body, now);
          out[lite.itemId] = lite;
          await this.cache.set(`viability-lite:${lite.itemId}`, lite, CACHE_TTL);
        }
      }
    }
    // recusados pelo ML (anúncios de terceiros): data pela descrição; se o ML também barrar a descrição, estimada
    let descriptionOpen: boolean | null = null;
    let token: string | null = null;
    for (const id of ids) {
      if (out[id]) continue;
      let exact: string | null = null;
      if (descriptionOpen !== false) {
        token ??= await this.anyToken(tenantId);
        exact = await optional(this.createdAtFromDescription(token, id));
        descriptionOpen ??= exact !== null;
      }
      const at = exact ?? (await this.estimate(tenantId, id));
      const age = ageInDays(at, new Date());
      out[id] = at
        ? { itemId: id, price: null, createdAt: at, createdAtEstimated: !exact, fromApi: false, ageDays: age, soldQuantity: null, salesPerDay: null, catalog: null, listingType: null, freeShipping: null, logisticType: null }
        : null;
    }
    return out;
  }

  /**
   * Anúncio de terceiro: data pela descrição do anúncio (criada junto com ele) ou estimada pelo número;
   * visitas pela janela diária ou, se o ML não liberar, mês a mês.
   */
  private async thirdParty(tenantId: string, token: string, id: string): Promise<ViabilityDto | null> {
    const now = new Date();
    const months = Array.from({ length: 6 }, (_, i) => {
      const from = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 5 + i, 1));
      const to = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + 1, 0));
      return { month: from.toISOString().slice(0, 7), from: from.toISOString().slice(0, 10), to: to.toISOString().slice(0, 10) };
    });
    const [createdExact, window, total, ...ranges] = await Promise.all([
      optional(this.createdAtFromDescription(token, id)),
      optional(this.api.rawGet<MlVisitsWindow>(token, `/items/${id}/visits/time_window?last=${VISIT_DAYS}&unit=day`)),
      optional(this.api.rawGet<Record<string, number>>(token, `/visits/items?ids=${id}`)),
      ...months.map((m) => optional(this.api.rawGet<{ total_visits?: number }[]>(token, `/items/visits?ids=${id}&date_from=${m.from}&date_to=${m.to}`))),
    ]);
    const monthlyRaw = months.map((m, i) => ({ month: m.month, total: ranges[i]?.[0]?.total_visits ?? null }));
    this.log?.warn(
      { id, description: createdExact, timeWindow: Boolean(window), total: total?.[id] ?? null, monthly: monthlyRaw.filter((m) => m.total !== null).length },
      'Viabilidade: dados liberados pelo ML para anúncio de terceiro',
    );

    const createdAt = createdExact ?? (await this.estimate(tenantId, id));
    if (!createdAt && !window && !total) return null;
    const age = ageInDays(createdAt, now);
    const daily = (window?.results ?? []).map((r) => ({ date: r.date.slice(0, 10), total: r.total ?? 0 }));
    const monthly = daily.length ? monthlyVisits(daily) : monthlyRaw.filter((m): m is { month: string; total: number } => m.total !== null);
    const visitsTotal = window?.total_visits ?? (monthly.length ? monthly.reduce((acc, m) => acc + m.total, 0) : null);
    const visits = daily.length || monthly.length ? { total: visitsTotal ?? 0, daily, monthly } : null;
    return {
      itemId: id, title: '', permalink: null, thumbnail: null, price: null, createdAt, createdAtEstimated: !createdExact, fromApi: false,
      ageDays: age, soldQuantity: null, salesPerDay: null, catalog: null, listingType: null, freeShipping: null, logisticType: null,
      availableQuantity: null, seller: null, visits, unavailable: visits ? ['vendas', 'tipo'] : ['vendas', 'tipo', 'visitas'],
      fetchedAt: now.toISOString(),
    };
  }

  /** A descrição do anúncio nasce com ele: a data dela é a data de criação. Guardada por 30 dias (não muda). */
  private async createdAtFromDescription(token: string, id: string): Promise<string | null> {
    const key = `viability-created:${id}`;
    const hit = await this.cache.get<{ at: string | null }>(key);
    if (hit) return hit.at;
    const d = await this.api.rawGet<{ date_created?: string | null }>(token, `/items/${id}/description`);
    const at = d?.date_created && !Number.isNaN(Date.parse(d.date_created)) ? new Date(d.date_created).toISOString() : null;
    await this.cache.set(key, { at }, at ? 30 * 86_400 : 86_400);
    return at;
  }

  /** Precisão da data estimada nos anúncios da própria empresa (cada um estimado sem a sua data real). */
  async accuracy(tenantId: string): Promise<ViabilityAccuracyDto> {
    await this.ensureFeature(tenantId);
    const raw = await this.rawAnchors(tenantId);
    const e = estimateError(raw, Date.now());
    return { anchors: raw.length, sample: e?.n ?? 0, medianDays: e?.medianDays ?? null, p90Days: e?.p90Days ?? null };
  }

  /** Data estimada (ISO) pelo número do anúncio, com os anúncios da empresa como referência. */
  private async estimate(tenantId: string, id: string): Promise<string | null> {
    const n = mlbNumber(id);
    if (n === null) return null;
    const key = `viability-anchors:${tenantId}`;
    let anchors = await this.cache.get<IdAnchor[]>(key);
    if (!anchors) {
      anchors = prepareAnchors(await this.rawAnchors(tenantId));
      await this.cache.set(key, anchors, ANCHORS_TTL);
    }
    const t = estimateTime(n, anchors, Date.now());
    return t === null ? null : new Date(t).toISOString();
  }

  private async rawAnchors(tenantId: string): Promise<IdAnchor[]> {
    const rows = await this.db.withTenant(tenantId, (c) =>
      c.query<{ external_id: string; listed_at: Date }>(
        `SELECT external_id, listed_at FROM listings
          WHERE marketplace = 'mercado_livre' AND listed_at IS NOT NULL AND external_id ~ '^MLB[0-9]+$'`,
      ),
    );
    return rows.rows.map((r) => ({ id: Number(r.external_id.slice(3)), t: r.listed_at.getTime() }));
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

function toLite(item: MlItemLite, now: Date): ViabilityLiteDto {
  const age = ageInDays(item.date_created, now);
  return {
    itemId: item.id,
    price: item.price ?? null,
    createdAt: item.date_created ?? null,
    createdAtEstimated: false,
    fromApi: true,
    ageDays: age,
    soldQuantity: item.sold_quantity ?? null,
    salesPerDay: salesPerDay(item.sold_quantity, age),
    catalog: item.catalog_listing ?? null,
    listingType: typeLabel(item.listing_type_id ?? null),
    freeShipping: item.shipping?.free_shipping ?? null,
    logisticType: item.shipping?.logistic_type ?? null,
  };
}
