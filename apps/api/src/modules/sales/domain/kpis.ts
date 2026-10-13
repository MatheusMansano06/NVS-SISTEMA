import type { KpiSet } from '@nvs/shared';

export interface KpiTotals {
  revenue: number;
  fees: number; // tarifas + frete
  cost: number; // custo dos produtos
  tax: number; // impostos (imposto % do cadastro de SKU sobre o valor vendido)
  orders: number;
  units: number;
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
  };
}
