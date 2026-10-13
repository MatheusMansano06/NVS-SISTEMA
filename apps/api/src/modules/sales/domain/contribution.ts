/**
 * Margem de contribuição por pedido (NVS-WMS: aggregator.compute_line_mc).
 * O frete comprador só entra na base quando a modalidade é ME1 ou "a combinar" (outros):
 * nesses casos o vendedor recebe e paga o frete.
 */
export interface OrderFinance {
  produto: number; // soma dos itens
  freteComprador: number;
  freteVendedor: number;
  custo: number;
  imposto: number;
  tarifa: number;
  cupom: number;
  devolucao: number;
  bucket: string;
}

const KEEPS_BUYER_FREIGHT = new Set(['me1', 'outros']);
const round2 = (v: number) => Math.round(v * 100) / 100;

export function contributionMargin(
  o: OrderFinance,
  considerarFreteComprador = false,
): { mc: number; mcPct: number; faturamentoLinha: number } {
  const faturamentoLinha = o.produto + o.freteComprador - o.cupom - o.devolucao;
  const keeps = considerarFreteComprador || KEEPS_BUYER_FREIGHT.has(o.bucket);
  const base = keeps ? faturamentoLinha : o.produto - o.cupom - o.devolucao;
  const mc = base - o.custo - o.imposto - o.tarifa - o.freteVendedor;
  return {
    mc: round2(mc),
    mcPct: o.produto > 0 ? round2((mc / o.produto) * 100) : 0,
    faturamentoLinha: round2(faturamentoLinha),
  };
}
