import type { IncomingListing, IncomingOrder } from '../../sales/index.js';
import { buyerShippingCost, partialRefund, type MlPayment } from './ml-finance.js';

/** Subconjunto do pedido da API do Mercado Livre que usamos. */
export interface MlOrder {
  id: number;
  status: string;
  date_created: string;
  total_amount: number;
  order_items: {
    item: { id: string; title: string; seller_sku?: string | null; seller_custom_field?: string | null };
    quantity: number;
    unit_price: number;
    sale_fee?: number | null;
    listing_type_id?: string | null;
  }[];
  shipping?: { id?: number | null } | null;
  payments?: MlPayment[] | null;
  buyer?: { nickname?: string | null } | null;
  pack_id?: number | string | null;
}

const STATUS: Record<string, IncomingOrder['status']> = {
  paid: 'paid',
  cancelled: 'cancelled',
  invalid: 'cancelled',
  partially_refunded: 'returned',
};

const round2 = (n: number) => Math.round(n * 100) / 100;

const mainPayment = (payments: MlPayment[] | null | undefined) =>
  (payments ?? []).find((p) => p.status === 'approved') ?? payments?.[0] ?? null;

/** SKU "humano" (regra do NVS-WMS): códigos gerados pelo ML (MLB…_…) não servem como SKU. */
const looksHuman = (s: string | null | undefined): s is string => Boolean(s) && !(s!.startsWith('MLB') && s!.includes('_'));

export function sellerSku(item: { id: string; seller_sku?: string | null; seller_custom_field?: string | null }): string {
  if (looksHuman(item.seller_sku)) return item.seller_sku.trim();
  if (looksHuman(item.seller_custom_field)) return item.seller_custom_field.trim();
  return (item.seller_custom_field || item.seller_sku || item.id).trim();
}

/** Converte o pedido do ML para o formato do módulo de vendas. Status irrelevantes → null. */
export function mapMlOrder(o: MlOrder): IncomingOrder | null {
  const status = STATUS[o.status];
  if (!status) return null;
  const items = o.order_items.map((i) => ({
    sku: sellerSku(i.item),
    title: i.item.title,
    quantity: i.quantity,
    unitPrice: i.unit_price,
    listingId: i.item.id,
  }));
  return {
    externalId: String(o.id),
    status,
    orderedAt: o.date_created,
    gross: round2(o.total_amount),
    // sale_fee vem por unidade
    fee: round2(o.order_items.reduce((s, i) => s + (i.sale_fee ?? 0) * i.quantity, 0)),
    units: o.order_items.reduce((s, i) => s + i.quantity, 0),
    shippingRef: o.shipping?.id ? String(o.shipping.id) : null,
    buyerShipping: buyerShippingCost(o.payments, null),
    refundPartial: partialRefund(o.status, o.payments),
    listingType: o.order_items[0]?.listing_type_id ?? null,
    buyerNickname: o.buyer?.nickname ?? null,
    packId: o.pack_id != null ? String(o.pack_id) : null,
    // o pagamento principal (o de maior valor aprovado) define a forma de pagamento
    paymentType: mainPayment(o.payments)?.payment_type ?? null,
    installments: mainPayment(o.payments)?.installments ?? null,
    items,
  };
}

/** Subconjunto do anúncio (GET /items) que usamos. */
export interface MlItem {
  id: string;
  title: string;
  status: string;
  sub_status?: string[] | null;
  price?: number | null;
  available_quantity?: number | null;
  original_price?: number | null;
  permalink?: string | null;
  secure_thumbnail?: string | null;
  thumbnail?: string | null;
  pictures?: { secure_url?: string | null; url?: string | null }[] | null;
  seller_custom_field?: string | null;
  sold_quantity?: number | null;
  listing_type_id?: string | null;
  category_id?: string | null;
  date_created?: string | null;
  catalog_listing?: boolean | null;
  shipping?: { free_shipping?: boolean | null; logistic_type?: string | null; dimensions?: string | null } | null;
  attributes?: { id: string; value_name?: string | null }[] | null;
  variations?: {
    seller_custom_field?: string | null;
    attributes?: { id: string; value_name?: string | null }[] | null;
  }[] | null;
}

const attrSku = (attrs: { id: string; value_name?: string | null }[] | null | undefined) =>
  attrs?.find((a) => a.id === 'SELLER_SKU')?.value_name?.trim() || null;

const https = (url: string | null | undefined) => (url ? url.replace(/^http:\/\//, 'https://') : null);

export function mapMlItem(i: MlItem): IncomingListing {
  return {
    externalId: i.id,
    title: i.title,
    // primeira foto em boa resolução; miniatura como reserva
    pictureUrl: https(i.pictures?.[0]?.secure_url ?? i.pictures?.[0]?.url ?? i.secure_thumbnail ?? i.thumbnail),
    permalink: i.permalink ?? null,
    price: i.price ?? null,
    availableQuantity: i.available_quantity ?? null,
    status: i.status,
    subStatus: i.sub_status ?? [],
    soldQuantity: i.sold_quantity ?? null,
    listingTypeId: i.listing_type_id ?? null,
    categoryId: i.category_id ?? null,
    freeShipping: i.shipping?.free_shipping ?? false,
    logisticType: i.shipping?.logistic_type ?? null,
    catalogListing: i.catalog_listing ?? false,
    picturesCount: i.pictures?.length ?? null,
    dimensions: i.shipping?.dimensions ?? null,
    listedAt: i.date_created ?? null,
    // preço cheio só quando o anúncio está mesmo com desconto
    originalPrice: i.original_price != null && i.price != null && i.original_price > i.price + 0.005 ? i.original_price : null,
    feeBonus: null,
    promoName: null,
    sku: attrSku(i.attributes) || i.seller_custom_field?.trim() || null,
    variationSkus: [
      ...new Set(
        (i.variations ?? [])
          .map((v) => attrSku(v.attributes) || v.seller_custom_field?.trim() || null)
          .filter((x): x is string => Boolean(x)),
      ),
    ],
  };
}

/** Promoção do anúncio (GET /seller-promotions/items/{id}). */
export interface MlItemPromotion {
  id?: string | null;
  name?: string | null;
  type?: string | null;
  status?: string | null;
  original_price?: number | null;
  meli_percentage?: number | null;
}

/**
 * Bônus de tarifa (regra do NVS-WMS): em campanhas co-financiadas o ML banca `meli_percentage`% do preço
 * cheio; esse valor volta para o vendedor a cada venda. Só a campanha em andamento conta.
 */
export function feeBonusOf(promos: MlItemPromotion[], fallbackOriginal: number | null): { bonus: number; name: string | null } | null {
  for (const p of promos) {
    if ((p.status ?? '').toLowerCase() !== 'started') continue;
    const base = p.original_price ?? fallbackOriginal;
    if (p.meli_percentage && base) {
      return { bonus: Math.round(base * p.meli_percentage) / 100, name: p.name ?? null };
    }
  }
  return null;
}
