import { describe, expect, it } from 'vitest';
import { adGoalInputSchema, adMetric, adRuleInputSchema, formatAdMetric, sumAdTotals, type AdTotals } from './ads-radar.js';

// Campanha VISEIRA A3, 7 dias (números reais lidos da API do ML em 20/10/2026)
const viseira: AdTotals = {
  cost: 84.62, clicks: 410, prints: 144180, directAmount: 2392.33, indirectAmount: 254.6, units: 71, organicUnits: 47, organicAmount: 1800,
};

describe('adMetric', () => {
  it('bate com o que o ML mostra', () => {
    expect(adMetric('acos', viseira)).toBe(3.2);
    expect(adMetric('roas', viseira)).toBe(31.28);
    expect(adMetric('cpc', viseira)).toBe(0.21);
    expect(adMetric('ctr', viseira)).toBe(0.28);
    expect(adMetric('conversao', viseira)).toBe(17.32);
  });
  it('TACOS inclui a venda orgânica', () => {
    expect(adMetric('tacos', viseira)).toBe(1.9); // 84,62 ÷ (2.646,93 + 1.800)
  });
  it('null sem base de cálculo', () => {
    const zero = sumAdTotals([]);
    expect(adMetric('acos', zero)).toBeNull();
    expect(adMetric('acos_vs_alvo', viseira)).toBeNull();
    expect(adMetric('investimento', zero)).toBe(0);
  });
  it('ACOS contra o alvo da campanha', () => {
    expect(adMetric('acos_vs_alvo', viseira, { acosTarget: 3.33 })).toBe(-0.13);
  });
});

describe('formatAdMetric', () => {
  it('formata por unidade', () => {
    expect(formatAdMetric('tacos', 5.2)).toBe('5,2%');
    expect(formatAdMetric('acos_vs_alvo', 1.25)).toBe('+1,3 p.p.');
    expect(formatAdMetric('investimento', 1234.5)).toBe('R$ 1.234,50');
    expect(formatAdMetric('roas', 9.8)).toBe('9,8x');
    expect(formatAdMetric('cliques', 3120)).toBe('3.120');
  });
});

describe('validação', () => {
  const base = { name: 'TACOS alto', scope: 'campanhas', conditions: [{ metric: 'tacos', window: '7d', op: 'maior', value: 4 }] };
  it('regra válida com padrões', () => {
    expect(adRuleInputSchema.parse(base)).toMatchObject({ accountId: null, campaignId: null, enabled: true, cooldownHours: 24 });
  });
  it('regra de uma campanha exige a campanha', () => {
    expect(adRuleInputSchema.safeParse({ ...base, scope: 'campanha' }).success).toBe(false);
    expect(adRuleInputSchema.safeParse({ ...base, scope: 'campanha', campaignId: 355665424 }).success).toBe(true);
  });
  it('regra sem condição é recusada', () => {
    expect(adRuleInputSchema.safeParse({ ...base, conditions: [] }).success).toBe(false);
  });
  it('metas', () => {
    expect(adGoalInputSchema.safeParse({ kind: 'gasto_mes', periodStart: '2026-10-01', target: 32000 }).success).toBe(true);
    expect(adGoalInputSchema.safeParse({ kind: 'gasto_mes', target: 32000 }).success).toBe(false);
    expect(adGoalInputSchema.safeParse({ kind: 'gasto_ano', periodStart: '2026-03-01', target: 1 }).success).toBe(false);
    expect(adGoalInputSchema.safeParse({ kind: 'tacos', target: 4 }).success).toBe(true);
    expect(adGoalInputSchema.safeParse({ kind: 'tacos', target: 140 }).success).toBe(false);
  });
});
