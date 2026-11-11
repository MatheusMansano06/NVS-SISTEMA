import type { IncomingOrder } from '../../sales/index.js';

/** Subconjunto do pedido da Shopee (v2.order.get_order_detail) que usamos. Valores monetários vêm como número. */
export interface ShopeeOrder {
  order_sn: string;
  order_status: string;
  /** Segundos Unix. */
  create_time: number;
  /** Quando foi pago (ausente = nunca pago). */
  pay_time?: number | null;
  /** Total pago pelo comprador. */
  total_amount?: number | null;
  payment_method?: string | null;
  /** fulfilled_by_shopee (Full) ou fulfilled_by_local_seller (envio do vendedor). */
  fulfillment_flag?: string | null;
  item_list?: {
    item_id?: number | string | null;
    item_name?: string | null;
    item_sku?: string | null;
    model_id?: number | string | null;
    model_name?: string | null;
    model_sku?: string | null;
    model_quantity_purchased?: number | null;
    model_original_price?: number | null;
    /** Preço de venda do item (já com as promoções do vendedor). */
    model_discounted_price?: number | null;
    image_info?: { image_url?: string | null } | null;
  }[] | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

/** Pedido pago em algum momento. Cancelado antes do pagamento (desistência no checkout) não é venda. */
export function wasPaid(o: Pick<ShopeeOrder, 'order_status' | 'pay_time'>): boolean {
  return Boolean(o.pay_time) || (o.order_status !== 'CANCELLED' && o.order_status !== 'UNPAID');
}

/**
 * Converte o pedido da Shopee para o módulo de vendas. Os valores financeiros aqui são provisórios: na mesma
 * sincronização o escrow do pedido (repasse estimado ou liberado) substitui produto, cupom, tarifa e fretes.
 */
export function mapShopeeOrder(o: ShopeeOrder): IncomingOrder | null {
  if (o.order_status === 'UNPAID' || !wasPaid(o)) return null;
  const status: IncomingOrder['status'] = o.order_status === 'CANCELLED' ? 'cancelled' : 'paid';
  const bySku = new Map<string, IncomingOrder['items'][number]>();
  for (const it of o.item_list ?? []) {
    const qty = Math.max(1, num(it.model_quantity_purchased));
    const price = num(it.model_discounted_price ?? it.model_original_price);
    const sku = (it.model_sku || it.item_sku || String(it.item_id ?? '?')).trim();
    const cur = bySku.get(sku);
    if (cur) {
      cur.unitPrice = round2((cur.unitPrice * cur.quantity + price * qty) / (cur.quantity + qty));
      cur.quantity += qty;
    } else {
      bySku.set(sku, {
        sku,
        title: [it.item_name, it.model_name].filter(Boolean).join(' · ') || 'Produto',
        quantity: qty,
        unitPrice: round2(price),
        listingId: it.item_id != null ? String(it.item_id) : null,
        pictureUrl: it.image_info?.image_url ?? null,
      });
    }
  }
  const items = [...bySku.values()];
  const flag = o.fulfillment_flag === 'fulfilled_by_shopee' ? 'shopee_full' : o.fulfillment_flag === 'fulfilled_by_local_seller' ? 'shopee_seller' : null;
  return {
    externalId: o.order_sn,
    status,
    orderedAt: new Date(o.create_time * 1000).toISOString(),
    gross: round2(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)),
    fee: 0,
    units: items.reduce((s, i) => s + i.quantity, 0),
    shippingRef: null,
    buyerShipping: 0,
    refundPartial: 0,
    listingType: flag,
    paymentType: o.payment_method ?? null,
    gmv: o.total_amount != null ? round2(num(o.total_amount)) : null,
    items,
  };
}
