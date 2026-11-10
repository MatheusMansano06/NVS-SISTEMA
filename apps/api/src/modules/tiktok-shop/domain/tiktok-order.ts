import type { IncomingOrder } from '../../sales/index.js';

/** Subconjunto do pedido da API do TikTok Shop (Order 202309) que usamos. Valores monetários vêm como texto. */
export interface TiktokOrder {
  id: string;
  status: string;
  /** Segundos Unix. */
  create_time: number;
  payment_method_name?: string | null;
  payment?: Record<string, string | undefined> | null;
  /** Uma linha por UNIDADE vendida (não há campo de quantidade). */
  line_items?: {
    sku_id?: string | null;
    product_id?: string | null;
    seller_sku?: string | null;
    product_name?: string | null;
    sku_name?: string | null;
    sale_price?: string | null;
    original_price?: string | null;
    seller_discount?: string | null;
    platform_discount?: string | null;
  }[] | null;
}

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Não pago ainda não é venda; cancelado sai da receita; o resto (a enviar, em trânsito, entregue) é venda. */
const STATUS: Record<string, IncomingOrder['status'] | null> = {
  UNPAID: null,
  CANCELLED: 'cancelled',
};

/**
 * Tarifas do TikTok Shop Brasil vigentes desde 15/07/2026 (comissão + tarifa fixa por item), usadas só como
 * ESTIMATIVA enquanto o pedido não foi repassado: depois do repasse vale o valor cobrado de fato (extrato).
 * Não inclui afiliado nem Frete Grátis (variam por pedido e só aparecem no extrato).
 */
export const TIKTOK_FEES = { threshold: 50, below: { pct: 0.1, fixed: 4 }, from: { pct: 0.06, fixed: 6 } } as const;

export function estimateFee(unitPrice: number, quantity: number): number {
  const f = unitPrice < TIKTOK_FEES.threshold ? TIKTOK_FEES.below : TIKTOK_FEES.from;
  return round2((unitPrice * f.pct + f.fixed) * quantity);
}

/** Converte o pedido do TikTok Shop para o formato do módulo de vendas. Status irrelevantes → null. */
export function mapTiktokOrder(o: TiktokOrder): IncomingOrder | null {
  const status = o.status in STATUS ? STATUS[o.status] : 'paid';
  if (!status) return null;

  // agrupa as unidades por SKU; o que o vendedor recebe por unidade = preço pago + desconto bancado pelo TikTok
  const bySku = new Map<string, IncomingOrder['items'][number]>();
  for (const li of o.line_items ?? []) {
    const price =
      li.sale_price != null ? num(li.sale_price) + num(li.platform_discount) : num(li.original_price) - num(li.seller_discount);
    const key = li.sku_id ?? li.seller_sku ?? li.product_id ?? '?';
    const cur = bySku.get(key);
    if (cur) {
      cur.unitPrice = round2((cur.unitPrice * cur.quantity + price) / (cur.quantity + 1));
      cur.quantity += 1;
    } else {
      bySku.set(key, {
        sku: (li.seller_sku || li.sku_id || li.product_id || '?').trim(),
        title: [li.product_name, li.sku_name].filter(Boolean).join(' · ') || 'Produto',
        quantity: 1,
        unitPrice: round2(price),
        listingId: li.product_id ?? null,
      });
    }
  }
  const items = [...bySku.values()];
  return {
    externalId: String(o.id),
    status,
    orderedAt: new Date(o.create_time * 1000).toISOString(),
    gross: round2(items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)),
    fee: status === 'cancelled' ? 0 : round2(items.reduce((s, i) => s + estimateFee(i.unitPrice, i.quantity), 0)),
    units: items.reduce((s, i) => s + i.quantity, 0),
    shippingRef: null,
    // o frete do comprador vai para a logística do TikTok; o que pesa no vendedor vem líquido no extrato
    buyerShipping: 0,
    refundPartial: 0,
    listingType: null,
    paymentType: o.payment_method_name ?? null,
    items,
  };
}

/** O que o extrato do pedido (Finance: statement_transactions) cobra do vendedor. */
export interface TiktokSettlement {
  /** Comissão, tarifas de serviço, afiliados e impostos retidos (valor positivo). */
  fee: number;
  /** Frete líquido pago pelo vendedor (valor positivo; 0 quando o TikTok devolveu mais do que cobrou). */
  shipping: number;
}

/** Onde as transações podem vir, conforme a versão da API (por extrato, genérico ou por SKU). */
const TX_LISTS = ['statement_transactions', 'transactions', 'sku_transactions'] as const;

/**
 * Lê o extrato de um pedido. Aceita os totais no nível do pedido ou a soma das transações (formatos 202309/202501).
 * No extrato, cobranças vêm negativas. Sem nenhuma transação = pedido ainda não repassado → null.
 */
export function parseSettlement(data: unknown): TiktokSettlement | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const txs = (TX_LISTS.map((k) => d[k]).find((v) => Array.isArray(v) && v.length) ?? []) as Record<string, unknown>[];
  if (!txs.length) return null;
  const total = (field: string) => (d[field] != null ? num(d[field]) : txs.reduce((s, t) => s + num(t[field]), 0));
  return {
    fee: round2(Math.max(0, -total('fee_and_tax_amount'))),
    shipping: round2(Math.max(0, -total('shipping_cost_amount'))),
  };
}
