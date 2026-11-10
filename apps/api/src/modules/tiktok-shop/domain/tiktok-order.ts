import type { IncomingOrder } from '../../sales/index.js';

/** Subconjunto do pedido da API do TikTok Shop (Order 202309) que usamos. Valores monetários vêm como texto. */
export interface TiktokOrder {
  id: string;
  status: string;
  /** Segundos Unix. */
  create_time: number;
  payment_method_name?: string | null;
  /** TIKTOK (logística da plataforma) ou SELLER (envio próprio). */
  shipping_type?: string | null;
  /** Uma linha por UNIDADE vendida (a API não tem campo de quantidade). */
  line_items?: {
    sku_id?: string | null;
    product_id?: string | null;
    seller_sku?: string | null;
    product_name?: string | null;
    sku_name?: string | null;
    sku_image?: string | null;
    /** Preço de tabela, antes dos descontos. */
    original_price?: string | null;
    sale_price?: string | null;
    /** Desconto bancado pelo vendedor (promoção, oferta relâmpago, cupom). */
    seller_discount?: string | null;
    platform_discount?: string | null;
    /** Live em que o item foi vendido; vazio quando não veio de live. */
    room_id?: string | null;
  }[] | null;
}

const num = (v: unknown): number => {
  const n = Number(typeof v === 'string' ? v.trim() : v);
  return Number.isFinite(n) ? n : 0;
};
// `+ 0` tira o zero negativo (−0), que apareceria ao inverter o sinal de uma cobrança zerada
const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

/** Não pago ainda não é venda; cancelado sai da receita; o resto (a enviar, em trânsito, entregue) é venda. */
const STATUS: Record<string, IncomingOrder['status'] | null> = {
  UNPAID: null,
  CANCELLED: 'cancelled',
};

/**
 * Tarifas do TikTok Shop Brasil vigentes desde 15/07/2026 (comissão + tarifa fixa por item). É só o valor provisório
 * do pedido recém-importado: na mesma sincronização ele é trocado pela estimativa do próprio TikTok (pedidos ainda
 * sem repasse) ou pelo extrato (pedidos repassados).
 */
export const TIKTOK_FEES = { threshold: 50, below: { pct: 0.1, fixed: 4 }, from: { pct: 0.06, fixed: 6 } } as const;

export function estimateFee(unitPrice: number, quantity: number): number {
  const f = unitPrice < TIKTOK_FEES.threshold ? TIKTOK_FEES.below : TIKTOK_FEES.from;
  return round2((unitPrice * f.pct + f.fixed) * quantity);
}

/**
 * Converte o pedido do TikTok Shop para o formato do módulo de vendas (status irrelevantes → null), do jeito que o
 * extrato do TikTok apresenta: faturado = preço de tabela; o desconto bancado pelo vendedor vai separado (cupom).
 * O desconto bancado pelo TikTok não reduz a receita: o TikTok repassa esse valor ao vendedor.
 */
export function mapTiktokOrder(o: TiktokOrder): IncomingOrder | null {
  const status = o.status in STATUS ? STATUS[o.status] : 'paid';
  if (!status) return null;

  let coupon = 0;
  let fee = 0;
  // agrupa as unidades por SKU
  const bySku = new Map<string, IncomingOrder['items'][number]>();
  for (const li of o.line_items ?? []) {
    const sellerDiscount = num(li.seller_discount);
    // sem preço de tabela, reconstrói: preço pago + descontos
    const list = li.original_price != null ? num(li.original_price) : num(li.sale_price) + sellerDiscount + num(li.platform_discount);
    coupon += sellerDiscount;
    fee += estimateFee(list - sellerDiscount, 1);
    const key = li.sku_id ?? li.seller_sku ?? li.product_id ?? '?';
    const cur = bySku.get(key);
    if (cur) {
      cur.unitPrice = round2((cur.unitPrice * cur.quantity + list) / (cur.quantity + 1));
      cur.quantity += 1;
    } else {
      bySku.set(key, {
        sku: (li.seller_sku || li.sku_id || li.product_id || '?').trim(),
        title: [li.product_name, li.sku_name].filter(Boolean).join(' · ') || 'Produto',
        quantity: 1,
        unitPrice: round2(list),
        listingId: li.product_id ?? null,
        pictureUrl: li.sku_image ?? null,
      });
    }
  }
  const items = [...bySku.values()];
  return {
    externalId: String(o.id),
    status,
    orderedAt: new Date(o.create_time * 1000).toISOString(),
    gross: round2(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)),
    couponSeller: round2(coupon),
    fee: status === 'cancelled' ? 0 : round2(fee),
    units: items.reduce((s, i) => s + i.quantity, 0),
    shippingRef: null,
    // o frete do comprador vai para a logística do TikTok; o que pesa no vendedor vem líquido no extrato
    buyerShipping: 0,
    refundPartial: 0,
    // a tela mostra como tipo de envio (não há "tipo de anúncio" no TikTok)
    listingType: o.shipping_type === 'SELLER' || o.shipping_type === 'TIKTOK' ? `tiktok_${o.shipping_type.toLowerCase()}` : null,
    paymentType: o.payment_method_name ?? null,
    liveRoomId: (o.line_items ?? []).find((li) => li.room_id)?.room_id ?? null,
    items,
  };
}

/** Transação financeira do TikTok: de um extrato (repasse) ou a estimativa de um pedido ainda sem repasse (`est_`). */
export interface TiktokFinanceTx {
  id?: string | null;
  type?: string | null;
  order_id?: string | null;
  adjustment_order_id?: string | null;
  revenue_breakdown?: Record<string, unknown> | null;
  shipping_cost_breakdown?: Record<string, unknown> | null;
  fee_tax_breakdown?: { fee?: Record<string, unknown> | null; tax?: Record<string, unknown> | null } | null;
  [amount: string]: unknown;
}

export interface TiktokAmounts {
  /** Receita líquida (depois de descontos do vendedor e devoluções). */
  revenue: number;
  /** Comissão, tarifas de serviço, afiliados e impostos retidos, como custo do vendedor (positivo). */
  fee: number;
  /** Frete líquido como custo do vendedor (negativo quando o TikTok devolveu mais do que cobrou). */
  shipping: number;
  /** Ajuste (positivo = crédito para o vendedor). */
  adjustment: number;
  settlement: number;
  /** Devolvido ao comprador, já sem o desconto do vendedor. */
  refund: number;
  /** A soma das partes bateu com o líquido informado pelo TikTok (senão, a leitura do sinal foi presumida). */
  consistent: boolean;
}

/**
 * Lê os totais de uma transação. No extrato as cobranças vêm negativas (receita 200, frete −70, tarifas −30); como
 * a documentação se contradiz nesse ponto, o sinal é conferido pela conta do próprio TikTok: o líquido tem que ser
 * a soma das partes. Se só fechar com as cobranças positivas, elas são lidas assim.
 */
export function readAmounts(tx: TiktokFinanceTx, estimated = false): TiktokAmounts {
  const p = estimated ? 'est_' : '';
  const revenue = num(tx[`${p}revenue_amount`]);
  const fee = num(tx[`${p}fee_tax_amount`] ?? tx[`${p}fee_and_tax_amount`]);
  const shipping = num(tx[`${p}shipping_cost_amount`]);
  const adjustment = num(tx[`${p}adjustment_amount`]);
  const settlement = num(tx[`${p}settlement_amount`]);
  const closes = (total: number) => Math.abs(total - settlement) <= 0.02 || Math.abs(total + adjustment - settlement) <= 0.02;
  const signed = closes(revenue + fee + shipping);
  const unsigned = !signed && closes(revenue - fee - shipping);
  const r = tx.revenue_breakdown ?? {};
  return {
    revenue: round2(revenue),
    fee: round2(unsigned ? fee : -fee),
    shipping: round2(unsigned ? shipping : -shipping),
    adjustment: round2(adjustment),
    settlement: round2(settlement),
    // devolução do preço de tabela menos a parte do desconto do vendedor que voltou
    refund: round2(Math.max(0, Math.abs(num(r.refund_subtotal_before_discount_amount)) - Math.abs(num(r.seller_discount_refund_amount)))),
    consistent: signed || unsigned,
  };
}

/** Composição da transação para guardar: só os campos diferentes de zero (são dezenas, quase todos zerados). */
export function compactBreakdown(tx: TiktokFinanceTx): Record<string, number> {
  const out: Record<string, number> = {};
  const add = (group: Record<string, unknown> | null | undefined) => {
    for (const [k, v] of Object.entries(group ?? {})) {
      if (typeof v === 'object') continue;
      const n = num(v);
      if (n !== 0) out[k.replace(/_amount$/, '')] = n;
    }
  };
  add(tx.revenue_breakdown);
  add(tx.shipping_cost_breakdown);
  add(tx.fee_tax_breakdown?.fee);
  add(tx.fee_tax_breakdown?.tax);
  return out;
}
