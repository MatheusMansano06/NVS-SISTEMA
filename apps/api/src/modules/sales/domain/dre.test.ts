import { describe, expect, it } from 'vitest';
import type { DreEntryDto } from '@nvs/shared';
import { computeDre, entryActive, projectDre, type DreSales } from './dre.js';

const sales: DreSales = {
  receitaBruta: 10_000,
  cupom: 100,
  devolucao: 200,
  imposto: 700,
  custo: 3_000,
  custoEstimado: 500,
  impostoEstimado: 50,
  tarifa: 1_200,
  freteVendedor: 800,
  pedidos: 200,
  unidades: 250,
  semCustoQtd: 10,
  semCustoValor: 1_000,
};
const entry = (p: Partial<DreEntryDto>): DreEntryDto => ({
  id: p.name ?? 'x',
  name: 'x',
  kind: 'despesa_fixa',
  category: 'outros',
  basis: 'mensal',
  amount: 0,
  startMonth: '2026-01',
  endMonth: null,
  notes: null,
  details: null,
  ...p,
});

describe('DRE simplificado', () => {
  const entries = [
    entry({ name: 'Embalagem', kind: 'custo_variavel', basis: 'pedido', amount: 1.5 }), // 300
    entry({ name: 'Comissão', kind: 'custo_variavel', basis: 'percentual', amount: 2 }), // 200
    entry({ name: 'Aluguel', amount: 1_000 }),
    entry({ name: 'Salário', amount: 1_500, endMonth: '2026-09' }), // acabou antes de outubro
    entry({ name: 'Notebook', basis: 'unico', amount: 400, startMonth: '2026-10' }),
    entry({ name: 'Juros', kind: 'despesa_financeira', amount: 150 }),
  ];
  const base = { month: '2026-10', sales, adSpend: 300, difal: 40, entries, estimar: true };

  it('desce da venda até o lucro líquido', () => {
    const d = computeDre(base);
    const t = Object.fromEntries(d.sections.map((s) => [s.id, s.total]));
    expect(t).toEqual({
      receita: 10_000,
      deducoes: 1_090,
      cmv: 3_500,
      variaveis: 2_800,
      fixas: 1_400,
      financeiras: 150,
    });
    expect(d.subtotals).toEqual({
      receita_liquida: 8_910,
      lucro_bruto: 5_410,
      margem_contribuicao: 2_610,
      lucro_operacional: 1_210,
      lucro_liquido: 1_060,
    });
    // (1400 + 150) / 26,1%
    expect(d.pontoEquilibrio).toBeCloseTo(5_938.7, 1);
    expect(d.cobertura.estimado).toBe(true);
  });

  it('sem estimativa, as vendas sem custo não descontam custo', () => {
    const d = computeDre({ ...base, estimar: false });
    expect(d.sections.find((s) => s.id === 'cmv')!.total).toBe(3_000);
    expect(d.cobertura.estimado).toBe(false);
  });

  it('lançamento único vale só no mês de início; fim encerra o recorrente', () => {
    expect(entryActive(entries[4]!, '2026-10')).toBe(true);
    expect(entryActive(entries[4]!, '2026-11')).toBe(false);
    expect(entryActive(entries[3]!, '2026-10')).toBe(false);
    expect(entryActive(entries[2]!, '2025-12')).toBe(false);
  });

  it('projeção escala o que depende das vendas e mantém o fixo', () => {
    const p = projectDre(base, 2);
    expect(p.receitaBruta).toBe(20_000);
    // margem dobra (2610×2 = 5220, com DIFAL fixo: +40) − fixas e financeiras do mês
    expect(p.lucroLiquido).toBe(5_220 + 40 - 1_400 - 150);
  });
});
