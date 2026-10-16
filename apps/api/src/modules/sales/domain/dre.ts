import type { DreDto, DreEntryDto, DreItem, DreSection, DreSectionId, DreSubtotalId } from '@nvs/shared';

/** Totais das vendas do mês (mesmas regras da Análise Financeira), sem as canceladas exceto no frete do vendedor. */
export interface DreSales {
  /** produto (+ frete comprador quando o vendedor recebe o frete) das vendas não canceladas */
  receitaBruta: number;
  cupom: number;
  devolucao: number;
  imposto: number;
  custo: number;
  /** vendas sem custo cadastrado: estimados pela média das que têm custo */
  custoEstimado: number;
  impostoEstimado: number;
  tarifa: number;
  /** frete pago pelo vendedor, inclusive em canceladas e devolvidas */
  freteVendedor: number;
  pedidos: number;
  unidades: number;
  semCustoQtd: number;
  semCustoValor: number;
}

export interface DreInput {
  month: string; // AAAA-MM
  sales: DreSales;
  adSpend: number;
  difal: number;
  entries: DreEntryDto[];
  estimar: boolean;
}

type DreResult = Pick<DreDto, 'sections' | 'subtotals' | 'receitaBruta' | 'pedidos' | 'unidades' | 'pontoEquilibrio' | 'cobertura'>;

const r2 = (v: number) => Math.round(v * 100) / 100;
const brl = (v: number) => v.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** Lançamento vale no mês? (único: só no mês de início) */
export function entryActive(e: Pick<DreEntryDto, 'basis' | 'startMonth' | 'endMonth'>, month: string): boolean {
  if (e.basis === 'unico') return e.startMonth === month;
  return e.startMonth <= month && (!e.endMonth || e.endMonth >= month);
}

/** Valor do lançamento no mês, conforme a base (por mês, por pedido, % do faturamento ou único). */
export function entryValue(e: DreEntryDto, s: Pick<DreSales, 'pedidos' | 'receitaBruta'>): { valor: number; detail: string } {
  if (e.details) return { valor: r2(e.amount), detail: `salário R$ ${brl(e.details.salario)} + encargos e benefícios` };
  switch (e.basis) {
    case 'pedido':
      return { valor: r2(e.amount * s.pedidos), detail: `R$ ${brl(e.amount)} × ${s.pedidos.toLocaleString('pt-BR')} pedidos` };
    case 'percentual':
      return { valor: r2((e.amount / 100) * s.receitaBruta), detail: `${e.amount.toLocaleString('pt-BR')}% de R$ ${brl(s.receitaBruta)}` };
    case 'unico':
      return { valor: r2(e.amount), detail: 'pagamento único' };
    default:
      return { valor: r2(e.amount), detail: 'valor do mês' };
  }
}

export function computeDre(i: DreInput): DreResult {
  const s = i.sales;
  const auto = (key: string, label: string, valor: number, extra: Partial<DreItem> = {}): DreItem => ({ key, label, valor: r2(valor), auto: true, ...extra });
  const nonZero = (items: DreItem[]) => items.filter((x) => x.valor !== 0);
  const manual = (kind: DreEntryDto['kind']) =>
    i.entries
      .filter((e) => e.kind === kind && entryActive(e, i.month))
      .map((e): DreItem => ({ key: `e:${e.id}`, label: e.name, auto: false, entryId: e.id, ...entryValue(e, s) }));

  const items: Record<DreSectionId, DreItem[]> = {
    receita: [auto('vendas', 'Vendas no Mercado Livre', s.receitaBruta)],
    deducoes: nonZero([
      auto('cupom', 'Cupons de desconto que você bancou', s.cupom),
      auto('devolucao', 'Devoluções parciais', s.devolucao),
      auto('imposto', 'Impostos sobre as vendas', s.imposto),
      ...(i.estimar ? [auto('imposto_est', 'Impostos das vendas sem custo (estimado)', s.impostoEstimado, { estimated: true })] : []),
      auto('difal', 'DIFAL cobrado pelo Mercado Livre', i.difal),
    ]),
    cmv: nonZero([
      auto('custo', 'Custo dos produtos vendidos', s.custo),
      ...(i.estimar ? [auto('custo_est', 'Custo das vendas sem custo cadastrado (estimado)', s.custoEstimado, { estimated: true })] : []),
    ]),
    variaveis: [
      ...nonZero([
        auto('tarifa', 'Tarifas do Mercado Livre', s.tarifa),
        auto('frete', 'Frete pago por você', s.freteVendedor),
        auto('ads', 'Mercado Ads (anúncios patrocinados)', i.adSpend),
      ]),
      ...manual('custo_variavel'),
    ],
    fixas: manual('despesa_fixa'),
    financeiras: manual('despesa_financeira'),
  };
  const total = (id: DreSectionId) => r2(items[id].reduce((a, x) => a + x.valor, 0));
  const t = Object.fromEntries(Object.keys(items).map((k) => [k, total(k as DreSectionId)])) as Record<DreSectionId, number>;

  const receitaLiquida = r2(t.receita - t.deducoes);
  const lucroBruto = r2(receitaLiquida - t.cmv);
  const margem = r2(lucroBruto - t.variaveis);
  const operacional = r2(margem - t.fixas);
  const liquido = r2(operacional - t.financeiras);
  const subtotals: Record<DreSubtotalId, number> = {
    receita_liquida: receitaLiquida,
    lucro_bruto: lucroBruto,
    margem_contribuicao: margem,
    lucro_operacional: operacional,
    lucro_liquido: liquido,
  };

  const mcRatio = t.receita > 0 ? margem / t.receita : 0;
  const sections: DreSection[] = (Object.keys(items) as DreSectionId[]).map((id) => ({ id, total: t[id], items: items[id] }));
  return {
    sections,
    subtotals,
    receitaBruta: r2(t.receita),
    pedidos: s.pedidos,
    unidades: s.unidades,
    pontoEquilibrio: mcRatio > 0 ? r2((t.fixas + t.financeiras) / mcRatio) : null,
    cobertura: { semCustoQtd: s.semCustoQtd, semCustoValor: r2(s.semCustoValor), estimado: i.estimar && s.semCustoQtd > 0 },
  };
}

/** Mês em andamento: projeta o que depende das vendas pelo ritmo até hoje; o que é por mês fica igual. */
export function projectDre(i: DreInput, factor: number): { receitaBruta: number; lucroLiquido: number } {
  const scaled = Object.fromEntries(Object.entries(i.sales).map(([k, v]) => [k, v * factor])) as unknown as DreSales;
  scaled.pedidos = Math.round(i.sales.pedidos * factor);
  const p = computeDre({ ...i, sales: scaled, adSpend: i.adSpend * factor });
  return { receitaBruta: p.receitaBruta, lucroLiquido: p.subtotals.lucro_liquido };
}
