import type {
  ListingDto,
  ListingListDto,
  ListingPricingDto,
  ListingMonthDto,
  ListingSalesDto,
  ListingTab,
  CategoryOptionDto,
} from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { formatDimensions, logisticOf, typeLabel, unitMargin } from '../domain/listing-margin.js';
import { MlApiError, type MlApi, type MlItemFull } from '../infrastructure/ml-api.js';
import { PgListingRepository, toNumber, type ListingRow } from '../infrastructure/pg-listing-repository.js';
import type { CachedMlLookups } from '../infrastructure/cached-ml-lookups.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Tarifa líquida do bônus que o ML banca na campanha (nunca negativa). */
const netFee = (fee: number | null, bonus: number) => (fee === null ? null : round2(Math.max(0, fee - bonus)));

class Blocked extends AppError {
  constructor(message: string) {
    super(message, 'LISTING_BLOCKED', 409);
  }
}

/** Aba Anúncios: leitura do catálogo local e ações no Mercado Livre (preço, estoque, status). */
export class ListingService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgListingRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
    private readonly lookups: CachedMlLookups,
  ) {}

  private toDto(r: ListingRow, taxPct: number): ListingDto {
    const price = toNumber(r.price);
    // 1º: tarifa/frete salvos para o preço atual; 2º: média das vendas dos últimos 90 dias
    const saved = r.pricing_price !== null && price !== null && Math.abs(Number(r.pricing_price) - price) < 0.005;
    const bonus = toNumber(r.fee_bonus) ?? 0;
    // a tarifa da tabela do ML não traz o bônus da campanha; a média das vendas já vem líquida
    const fee = saved ? netFee(toNumber(r.fee_amount), bonus) : toNumber(r.avg_fee);
    // frete salvo é o de tabela: aplica o desconto que você recebe (visto nas vendas)
    const savedFreight = toNumber(r.freight_cost);
    const ratio = toNumber(r.freight_paid_ratio) ?? 1;
    const freight = saved ? (savedFreight === null ? null : round2(savedFreight * ratio)) : toNumber(r.avg_freight);
    const hasSales = fee !== null && freight !== null;
    return {
      id: r.external_id,
      title: r.title,
      sku: r.sku,
      pictureUrl: r.picture_url,
      permalink: r.permalink,
      status: r.status,
      subStatus: r.sub_status,
      price,
      originalPrice: toNumber(r.original_price),
      feeBonus: toNumber(r.fee_bonus),
      promoName: r.promo_name,
      stock: r.available_quantity,
      sold: r.sold_quantity,
      type: typeLabel(r.listing_type_id),
      freeShipping: r.free_shipping,
      logistic: logisticOf(r.logistic_type),
      flex: r.flex_enabled,
      picturesCount: r.pictures_count,
      dimensions: formatDimensions(r.dimensions),
      listedAt: r.listed_at?.toISOString() ?? null,
      catalog: r.catalog_listing,
      cost: toNumber(r.custo_unit),
      margin: unitMargin({
        price,
        fee: fee === null ? null : round2(fee),
        freight: freight === null ? null : round2(freight),
        cost: toNumber(r.custo_unit),
        taxPct,
        source: !hasSales ? null : saved ? 'live' : 'sales',
      }),
      account: r.account_nickname,
    };
  }

  async list(tenantId: string, q: { status: ListingTab; q?: string; offset: number; limit: number }): Promise<ListingListDto> {
    const status = await this.ml.status(tenantId);
    return this.db.withTenant(tenantId, async (db) => {
      // mesmo client da transação: consultas em sequência
      const { rows, total } = await this.repo.list(db, q);
      const counts = await this.repo.counts(db);
      const taxPct = await this.repo.taxPct(db);
      return {
        items: rows.map((r) => this.toDto(r, taxPct)),
        total,
        counts,
        taxPct,
        connected: status.connections.length > 0,
      };
    });
  }

  async sales(tenantId: string, id: string, offset: number, limit: number): Promise<ListingSalesDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows, totals } = await this.repo.sales(db, id, offset, limit);
      return {
        items: rows.map((r) => ({
          orderId: r.order_id,
          orderedAt: r.ordered_at.toISOString(),
          status: r.status,
          quantity: r.quantity,
          unitPrice: Number(r.unit_price),
          gross: Number(r.gross),
          fee: Number(r.fee),
          freight: Number(r.freight),
          margin: toNumber(r.margin),
        })),
        total: Number(totals.total),
        totals: { orders: Number(totals.orders), units: Number(totals.units), gross: round2(Number(totals.gross)) },
      };
    });
  }

  async monthly(tenantId: string, id: string): Promise<ListingMonthDto[]> {
    const rows = await this.db.withTenant(tenantId, (db) => this.repo.monthly(db, id));
    return rows.map((r) => ({
      month: r.month,
      orders: Number(r.orders),
      units: Number(r.units),
      gross: Number(r.gross),
      fee: Number(r.fee),
      freight: Number(r.freight),
      tax: Number(r.tax),
      cost: toNumber(r.cost),
      margin: toNumber(r.margin),
    }));
  }

  /** Clássico ⇄ Premium. Muda a tarifa (e a exposição) do anúncio. */
  async setListingType(tenantId: string, id: string, type: 'gold_special' | 'gold_pro') {
    const { row, token, connectionId } = await this.session(tenantId, id);
    if (row.listing_type_id === type) return { id, type };
    if (row.status === 'closed') throw new Blocked('Anúncio finalizado: não é possível mudar o tipo.');
    await this.wrap(() => this.api.changeListingType(token, id, type));
    await this.ml.refreshListings(tenantId, connectionId, [id]);
    return { id, type };
  }

  async categories(tenantId: string, id: string, q: string): Promise<CategoryOptionDto[]> {
    const { token } = await this.session(tenantId, id);
    const r = await this.wrap(() => this.api.searchCategories(token, q));
    return r.map((c) => ({ id: c.category_id, name: c.category_name, domain: c.domain_name ?? null }));
  }

  /**
   * Duplica o anúncio como um NOVO item, já pausado para revisão: título, preço, atributos (menos
   * códigos universais), fotos, frete (nunca Full), garantia, variações e descrição.
   */
  async duplicate(tenantId: string, id: string, opts: { categoryId?: string; title?: string }) {
    const { token, connectionId } = await this.session(tenantId, id);
    const src = await this.wrap(() => this.api.itemFull(token, id));
    const body = duplicateBody(src, opts);
    const created = await this.wrap(() => this.api.createItem(token, body));
    await this.wrap(() => this.api.updateItem(token, created.id, { status: 'paused' }));
    const description = await this.api.description(token, id).catch(() => null);
    if (description) await this.api.setDescription(token, created.id, description).catch(() => undefined);
    await this.ml.refreshListings(tenantId, connectionId, [created.id]);
    return { id: created.id, permalink: created.permalink ?? null, status: 'paused' as const };
  }

  /** Exclui: o ML exige finalizar antes; depois marca como removido (o histórico fica no ML). */
  async remove(tenantId: string, id: string) {
    const { row, token } = await this.session(tenantId, id);
    if (row.status !== 'closed') await this.wrap(() => this.api.updateItem(token, id, { status: 'closed' }));
    await this.wrap(() => this.api.updateItem(token, id, { deleted: true }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { status: 'closed' }));
    return { id, deleted: true as const };
  }

  /** Conexão (e token) da conta dona do anúncio. */
  async session(tenantId: string, id: string) {
    const row = await this.db.withTenant(tenantId, (db) => this.repo.one(db, id));
    if (!row) throw new NotFoundError('Anúncio não encontrado');
    const status = await this.ml.status(tenantId);
    const conn = status.connections.find((c) => c.accountId === row.account_id);
    if (!conn || conn.status !== 'active') throw new Blocked('Conecte a conta do Mercado Livre para alterar este anúncio.');
    const { token, conn: c } = await this.ml.accessToken(tenantId, conn.id);
    return { row, token, mlUserId: c.ml_user_id, connectionId: conn.id };
  }

  /** Simula tarifa e frete reais para um preço (consulta ao vivo no marketplace). */
  /**
   * Tarifa e frete reais para um preço (padrão: o atual). Usa o cache de consultas ao ML (`refresh` ignora);
   * o preço vigente fica salvo no anúncio para a lista mostrar a margem sem consultar nada.
   */
  async pricing(tenantId: string, id: string, price?: number, refresh = false): Promise<ListingPricingDto> {
    const { row, token, mlUserId } = await this.session(tenantId, id);
    const current = toNumber(row.price);
    const isCurrent = price === undefined || (current !== null && Math.abs(price - current) < 0.005);
    const target = price ?? current;
    if (!target || target <= 0) throw new Blocked('Anúncio sem preço para simular.');
    const [fees, freightQuote, taxPct] = await Promise.all([
      this.wrap(() => this.lookups.listingFees(token, target, row.category_id, refresh)),
      row.free_shipping ? this.wrap(() => this.lookups.freeShippingCost(token, tenantId, mlUserId, id, refresh)) : Promise.resolve(0),
      this.db.withTenant(tenantId, (db) => this.repo.taxPct(db)),
    ]);
    const f = fees.find((x) => x.listing_type_id === row.listing_type_id);
    // o ML cota o frete de tabela; você paga com o desconto de reputação visto nas suas vendas
    const ratio = toNumber(row.freight_paid_ratio);
    const freightList = freightQuote === null ? null : round2(freightQuote);
    const freightCost = freightList === null ? null : freightList * (ratio ?? 1);
    const cost = toNumber(row.custo_unit);
    const bonus = toNumber(row.fee_bonus) ?? 0;
    const options = (['gold_special', 'gold_pro'] as const).flatMap((type) => {
      const o = fees.find((x) => x.listing_type_id === type);
      if (!o) return [];
      const oFee = netFee(round2(o.sale_fee_amount), bonus)!;
      const oFreight = freightCost === null ? null : round2(freightCost);
      return [{
        type,
        label: typeLabel(type)!,
        fee: oFee,
        feePct: o.sale_fee_details?.percentage_fee ?? null,
        margin: unitMargin({ price: target, fee: oFee, freight: oFreight, cost, taxPct, source: 'live' }),
      }];
    });
    // salva a tarifa bruta (tabela do ML); o bônus é aplicado na leitura
    const grossFee = f ? round2(f.sale_fee_amount) : null;
    const fee = netFee(grossFee, bonus);
    const freight = freightCost === null ? null : round2(freightCost);
    // só o preço vigente fica salvo (simulações de outro preço não sobrescrevem o banco)
    if (isCurrent) {
      await this.db.withTenant(tenantId, (db) =>
        this.repo.savePricing(db, id, { price: target, fee: grossFee, feePct: f?.sale_fee_details?.percentage_fee ?? null, freight: freightList }),
      );
    }
    return {
      price: target,
      fee,
      feePct: f?.sale_fee_details?.percentage_fee ?? null,
      freight,
      freightList,
      margin: unitMargin({ price: target, fee, freight, cost, taxPct, source: 'live' }),
      type: row.listing_type_id,
      options,
    };
  }

  async setPrice(tenantId: string, id: string, price: number) {
    const { row, token } = await this.session(tenantId, id);
    if (row.catalog_listing) throw new Blocked('Anúncio de catálogo: o preço não pode ser alterado por aqui.');
    if (row.status === 'closed') throw new Blocked('Anúncio finalizado: não é possível alterar o preço.');
    const next = round2(price);
    const item = await this.wrap(() => this.api.updateItem(token, id, { price: next }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { price: item.price ?? next }));
    return { id, price: item.price ?? next };
  }

  async setStock(tenantId: string, id: string, quantity: number) {
    const { row, token } = await this.session(tenantId, id);
    if (row.status === 'closed') throw new Blocked('Anúncio finalizado: não é possível alterar o estoque.');
    if (row.logistic_type === 'fulfillment') {
      throw new Blocked('Anúncio Full: o estoque é gerido pelo Mercado Livre e não pode ser alterado por aqui.');
    }
    const item = await this.wrap(() => this.api.updateItem(token, id, { available_quantity: quantity }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { stock: item.available_quantity ?? quantity }));
    return { id, stock: item.available_quantity ?? quantity };
  }

  async setStatus(tenantId: string, id: string, status: 'active' | 'paused' | 'closed') {
    const { row, token } = await this.session(tenantId, id);
    if (row.status === 'closed') throw new Blocked('Anúncio já finalizado: não é possível mudar o status.');
    const item = await this.wrap(() => this.api.updateItem(token, id, { status }));
    await this.db.withTenant(tenantId, (db) => this.repo.setLocal(db, id, { status: item.status ?? status }));
    return { id, status: item.status ?? status };
  }

  /** Erros do ML viram resposta 502 legível, sem vazar detalhes internos. */
  async wrap<T>(fn: () => Promise<T>): Promise<T> {
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

/** Atributos que não podem ser copiados: códigos universais geram "já existe"; SKU é do original. */
const NOT_COPIED = new Set(['GTIN', 'EAN', 'UPC', 'ISBN', 'SELLER_SKU']);

type AttrOut = { id: string; value_id?: string; value_name?: string };
const copyAttrs = (attrs: { id: string; value_id?: string | null; value_name?: string | null }[] | null | undefined): AttrOut[] =>
  (attrs ?? []).flatMap((a): AttrOut[] =>
    NOT_COPIED.has(a.id) ? [] : a.value_id ? [{ id: a.id, value_id: a.value_id }] : a.value_name != null ? [{ id: a.id, value_name: a.value_name }] : [],
  );

/** Corpo do POST /items a partir do anúncio de origem. */
export function duplicateBody(src: MlItemFull, opts: { categoryId?: string; title?: string }): Record<string, unknown> {
  const body: Record<string, unknown> = {
    title: (opts.title || src.title).trim(),
    category_id: opts.categoryId || src.category_id,
    currency_id: src.currency_id || 'BRL',
    buying_mode: src.buying_mode || 'buy_it_now',
    listing_type_id: src.listing_type_id || 'gold_special',
    condition: src.condition || 'new',
    pictures: (src.pictures ?? [])
      .map((p) => (p.secure_url || p.url || '').replace(/^http:/, 'https:'))
      .filter(Boolean)
      .map((source) => ({ source })),
    attributes: copyAttrs(src.attributes),
  };
  const sh = src.shipping;
  if (sh) {
    const shipping: Record<string, unknown> = {};
    if (sh.mode) shipping.mode = sh.mode;
    if (sh.local_pick_up != null) shipping.local_pick_up = sh.local_pick_up;
    if (sh.free_shipping != null) shipping.free_shipping = sh.free_shipping;
    // um anúncio novo não nasce no Full
    if (sh.logistic_type && sh.logistic_type !== 'fulfillment') shipping.logistic_type = sh.logistic_type;
    if (Object.keys(shipping).length) body.shipping = shipping;
  }
  const terms = (src.sale_terms ?? []).filter((t) => t.value_name != null).map((t) => ({ id: t.id, value_name: t.value_name }));
  if (terms.length) body.sale_terms = terms;
  if (src.variations?.length) {
    body.variations = src.variations.map((v) => ({
      attribute_combinations: v.attribute_combinations ?? [],
      available_quantity: Math.max(0, v.available_quantity ?? 0),
      ...(v.price != null ? { price: v.price } : {}),
      ...(copyAttrs(v.attributes).length ? { attributes: copyAttrs(v.attributes) } : {}),
    }));
  } else {
    if (src.price != null) body.price = src.price;
    body.available_quantity = Math.max(1, src.available_quantity ?? 1);
  }
  return body;
}
