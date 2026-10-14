import type { KpiSet } from '@nvs/shared';

export interface KpiTotals {
  revenue: number;
  fees: number; // tarifas + frete
  cost: number; // custo dos produtos
  tax: number; // impostos (imposto % do cadastro de SKU sobre o valor vendido)
  orders: number;
  units: number;
  ads?: number; // investido em Mercado Ads
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Regras dos indicadores: líquido = faturamento − tarifas − frete; lucro = líquido − custo − imposto. */
export function computeKpis(t: KpiTotals): KpiSet {
  const net = t.revenue - t.fees;
  const grossProfit = net - t.cost - t.tax;
  return {
    revenue: round2(t.revenue),
    net: round2(net),
    grossProfit: round2(grossProfit),
    margin: t.revenue > 0 ? grossProfit / t.revenue : 0,
    orders: t.orders,
    units: t.units,
    avgTicket: t.orders > 0 ? round2(t.revenue / t.orders) : 0,
    adSpend: round2(t.ads ?? 0),
    tacos: t.revenue > 0 ? (t.ads ?? 0) / t.revenue : 0,
    profitAfterAds: round2(grossProfit - (t.ads ?? 0)),
    marginAfterAds: t.revenue > 0 ? (grossProfit - (t.ads ?? 0)) / t.revenue : 0,
  };
}
