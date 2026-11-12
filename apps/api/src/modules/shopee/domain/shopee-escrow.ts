/**
 * Escrow (repasse) de um pedido da Shopee → canônico NVS. Port de `financeiro_ml/shopee_map.py` do NVS W2, conferido
 * contra o relatório do contador (MT) em 23/09/2026. Identidade:
 *   escrow = produto − cupom − (tarifa − tarifa_refund) + frete_comprador − frete_vendedor (+ ajuste)
 * O `ajuste` é o que a Shopee credita além desses componentes (rebates, subsídios); somado à margem, ela fecha com
 * o repasse: MC = escrow − custo − imposto.
 * Valores em centavos inteiros durante a conta (sem erro de ponto flutuante).
 */

export interface ShopeeEscrowDetail {
  order_sn?: string | null;
  return_order_sn_list?: string[] | null;
  order_income?: Record<string, unknown> | null;
}

export interface ShopeeEscrowRow {
  order_sn: string;
  produto: number;
  cupom: number;
  /** Tarifa bruta (comissão, serviço, transação, afiliados, Ads, proteção de frete). */
  tarifa: number;
  /** Desconto da Shopee devolvido ao vendedor (líquido do desconto Pix). */
  tarifa_refund: number;
  frete_comprador: number;
  frete_vendedor: number;
  escrow_amount: number;
  /** Escrow depois dos ajustes (compensação por extravio, reembolso de devolução...). */
  escrow_after_adjustment: number;
  /** Crédito além dos componentes (positivo = a Shopee pagou mais). */
  ajuste: number;
  /** Devolvido com reembolso ao comprador: não é venda. */
  returned: boolean;
  tarifas: Record<string, number>;
  quality_flags: string[];
  /** order_income sem a lista de itens, para conferência. */
  income: Record<string, unknown>;
}

const FEE_FIELDS: Record<string, string[]> = {
  commission_fee: ['commission_fee'],
  service_fee: ['service_fee'],
  shipping_seller_protection_fee_amount: ['shipping_seller_protection_fee_amount'],
  ads_fee: ['ads_escrow_top_up_fee_or_technical_support_fee'],
  affiliate_commission_fee: ['order_ams_commission_fee'],
  transaction_fee: ['transaction_fee', 'seller_transaction_fee'],
};

/** Custos que a Shopee pode cobrar e que ainda não têm lugar no canônico: marcam o pedido para conferência. */
const UNMAPPED_COST_FIELDS = [
  'actual_installation_fee', 'bcrs_deposit', 'campaign_fee', 'credit_card_transaction_fee', 'fbs_fee', 'reverse_shipping_fee',
  'seller_order_processing_fee', 'seller_withholding_tax', 'vat', 'withholding_taxes', 'total_adjustment_amount',
  'drc_adjustable_refund', 'seller_lost_compensation', 'seller_return_refund',
];
const REQUIRED_FIELDS = ['order_selling_price', 'buyer_paid_shipping_fee', 'actual_shipping_fee', 'order_discounted_price', 'escrow_amount'];

/** Valor em centavos (aceita número ou texto). */
const cents = (v: unknown): number => {
  if (v === null || v === undefined || v === '') return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};
const reais = (c: number) => c / 100 + 0;

/** Primeiro campo diferente de zero entre os nomes (a Shopee usa nomes alternativos para a mesma tarifa). */
function first(income: Record<string, unknown>, names: string[]): number {
  for (const name of names) if (cents(income[name]) !== 0) return cents(income[name]);
  return 0;
}

const nonzero = (v: unknown): boolean => {
  if (v === null || v === undefined || v === '') return false;
  if (Array.isArray(v)) return v.some(nonzero);
  if (typeof v === 'object') return Object.values(v as object).some(nonzero);
  const n = Number(v);
  return Number.isFinite(n) ? n !== 0 : true;
};

export function mapShopeeEscrow(detail: ShopeeEscrowDetail): ShopeeEscrowRow {
  const orderSn = String(detail.order_sn ?? '').trim();
  const income = detail.order_income;
  if (!orderSn || !income || typeof income !== 'object') throw new Error('escrow sem order_sn ou order_income');

  const flags = new Set<string>();
  if (REQUIRED_FIELDS.some((f) => income[f] === undefined || income[f] === null)) flags.add('financial_mapping_incomplete');

  const produto = cents(income.order_selling_price);
  const freteComprador = cents(income.buyer_paid_shipping_fee);
  const actualShipping = cents(income.actual_shipping_fee);
  const rebate = first(income, ['shopee_shipping_rebate', 'shipping_fee_rebate_from_shopee']);
  let freteVendedor = Math.max(0, actualShipping - rebate);

  const tarifas: Record<string, number> = {};
  let tarifa = 0;
  for (const [key, names] of Object.entries(FEE_FIELDS)) {
    const v = first(income, names);
    tarifas[key] = reais(v);
    tarifa += v;
  }

  const originalDiscount = cents(income.original_shopee_discount);
  const pixDiscount = cents(income.pix_discount);
  const tarifaRefund = Math.max(0, originalDiscount - pixDiscount);
  if (pixDiscount > originalDiscount) flags.add('financial_mapping_incomplete');

  const cupom = cents(income.voucher_from_seller) + Math.max(0, produto - cents(income.order_discounted_price));

  if (UNMAPPED_COST_FIELDS.some((f) => nonzero(income[f]))) flags.add('financial_mapping_incomplete');
  const escrow = cents(income.escrow_amount);
  const afterRaw = income.escrow_amount_after_adjustment;
  const after = afterRaw === undefined || afterRaw === null || afterRaw === '' ? escrow : cents(afterRaw);
  if (after !== escrow) flags.add('financial_mapping_incomplete');

  const identity = produto - cupom - (tarifa - tarifaRefund) + freteComprador - freteVendedor;
  const ajuste = escrow - identity;
  if (Math.abs(ajuste) > 1) flags.add('escrow_adjusted');

  // A Shopee credita o frete quando o próprio vendedor faz a entrega; o custo dessa entrega não vem no escrow:
  // o crédito fica reservado como frete do vendedor (sem lucro fictício). Depois do ajuste, para não voltar por ele.
  const finalShipping = cents(income.final_shipping_fee);
  if (finalShipping > 0 && actualShipping === 0 && freteComprador === 0) {
    freteVendedor += finalShipping;
    flags.add('direct_delivery_cost_unknown');
  }

  const { items: _items, ...rest } = income;
  return {
    order_sn: orderSn,
    produto: reais(produto),
    cupom: reais(cupom),
    tarifa: reais(tarifa),
    tarifa_refund: reais(tarifaRefund),
    frete_comprador: reais(freteComprador),
    frete_vendedor: reais(freteVendedor),
    escrow_amount: reais(escrow),
    escrow_after_adjustment: reais(after),
    ajuste: reais(ajuste),
    // sinal validado na conferência de 23/09/2026 (aba "zerados" do MT); produto zerado sozinho pegaria vendas
    returned: cents(income.seller_return_refund) < 0,
    tarifas,
    quality_flags: [...flags].sort(),
    income: rest,
  };
}

/** Valores que vão para o pedido em `orders`, com a margem fechando no repasse: MC = repasse − custo − imposto. */
export interface ShopeeOrderFinance {
  status: 'paid' | 'returned';
  gross: number;
  coupon: number;
  fee: number;
  shipping: number;
  buyerShipping: number;
  refund: number;
}

/**
 * Converte o escrow nos campos do pedido. A recarga de Ads (`ads_fee`) não é tarifa: o Ads é descontado à parte. Venda: tarifa líquida (menos o crédito da Shopee); o que sobrar de crédito
 * abate o frete do vendedor. Devolvida com reembolso: a venda inteira volta (devolução = produto) e o que a Shopee
 * repassou ou cobrou depois dos ajustes (ex.: compensação por extravio) fica no frete/tarifa.
 * `itemsGross` = soma dos itens do pedido, para a devolução quando o escrow já veio zerado.
 */
export function orderFinance(
  e: Pick<ShopeeEscrowRow, 'produto' | 'cupom' | 'tarifa' | 'tarifa_refund' | 'frete_comprador' | 'frete_vendedor' | 'ajuste' | 'returned' | 'escrow_after_adjustment'> & { ads_fee?: number },
  itemsGross: number,
): ShopeeOrderFinance {
  const c = (v: number) => Math.round(v * 100);
  if (e.returned) {
    const gross = Math.max(c(e.produto), c(itemsGross));
    const net = c(e.escrow_after_adjustment);
    return { status: 'returned', gross: reais(gross), coupon: 0, refund: reais(gross), buyerShipping: 0, fee: reais(Math.max(0, -net)), shipping: reais(-Math.max(0, net)) };
  }
  // a recarga de Ads tirada do repasse vai para a carteira de anúncios: o custo entra pelo gasto do Shopee Ads
  const tarifa = c(e.tarifa) - c(e.ads_fee ?? 0) - c(e.tarifa_refund) - c(e.ajuste);
  return {
    status: 'paid',
    gross: e.produto,
    coupon: e.cupom,
    fee: reais(Math.max(0, tarifa)),
    shipping: reais(c(e.frete_vendedor) + Math.min(0, tarifa)),
    buyerShipping: e.frete_comprador,
    refund: 0,
  };
}
