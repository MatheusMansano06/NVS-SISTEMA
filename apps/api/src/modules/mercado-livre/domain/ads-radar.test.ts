import { describe, expect, it } from 'vitest';
import { EMPTY_AD_TOTALS, type AdCondition } from '@nvs/shared';
import {
  addDays, canNotify, evaluateCondition, evaluateRule, goalPace, goalPeriod, previousRange, ruleMessage, simulateRule, statusAgainst,
  windowRange, type AdDay,
} from './ads-radar.js';

const TODAY = '2026-10-20';

/** Dia com investimento e venda; TACOS = cost ÷ (ads + orgânica). */
const day = (d: string, cost: number, adsSales: number, organic = 0, clicks = 100): AdDay => ({
  ...EMPTY_AD_TOTALS, day: d, cost, directAmount: adsSales, organicAmount: organic, clicks, prints: clicks * 100, units: 5,
});
/** Série de `n` dias até ontem, todos iguais. */
const flat = (n: number, cost: number, adsSales: number, organic = 0) => Array.from({ length: n }, (_, i) => day(addDays(TODAY, -n + i), cost, adsSales, organic));

describe('windowRange / previousRange', () => {
  it('janelas de dias fecham ontem; hoje e mês incluem hoje', () => {
    expect(windowRange('7d', TODAY)).toEqual({ from: '2026-10-13', to: '2026-10-19' });
    expect(windowRange('ontem', TODAY)).toEqual({ from: '2026-10-19', to: '2026-10-19' });
    expect(windowRange('hoje', TODAY)).toEqual({ from: TODAY, to: TODAY });
    expect(windowRange('mes', TODAY)).toEqual({ from: '2026-10-01', to: TODAY });
  });
  it('janela anterior tem o mesmo tamanho', () => {
    expect(previousRange({ from: '2026-10-13', to: '2026-10-19' })).toEqual({ from: '2026-10-06', to: '2026-10-12' });
  });
  it('atravessa a virada do mês', () => {
    expect(windowRange('3d', '2026-11-02')).toEqual({ from: '2026-10-30', to: '2026-11-01' });
  });
});

describe('statusAgainst', () => {
  it('maior: estoura acima do limite e avisa a 85%', () => {
    expect(statusAgainst(4.1, 'maior', 4)).toBe('estourado');
    expect(statusAgainst(3.5, 'maior', 4)).toBe('atencao');
    expect(statusAgainst(3, 'maior', 4)).toBe('ok');
  });
  it('menor: estoura abaixo do limite', () => {
    expect(statusAgainst(9, 'menor', 10)).toBe('estourado');
    expect(statusAgainst(11, 'menor', 10)).toBe('atencao');
    expect(statusAgainst(20, 'menor', 10)).toBe('ok');
  });
  it('sem valor não alarma', () => {
    expect(statusAgainst(null, 'maior', 4)).toBe('ok');
  });
});

describe('evaluateCondition', () => {
  it('TACOS de 7 dias soma os totais (não a média das porcentagens)', () => {
    const series = [...flat(6, 10, 200, 0), day('2026-10-19', 100, 100, 0)];
    const r = evaluateCondition({ metric: 'tacos', window: '7d', op: 'maior', value: 4 }, series, TODAY);
    // (6×10 + 100) ÷ (6×200 + 100) = 160 ÷ 1300 = 12,31%
    expect(r.current).toBe(12.31);
    expect(r.met).toBe(true);
  });
  it('ignora dias fora da janela, inclusive hoje nas janelas fechadas', () => {
    const series = [...flat(7, 2, 100, 0), day(TODAY, 500, 0)];
    expect(evaluateCondition({ metric: 'tacos', window: '7d', op: 'maior', value: 4 }, series, TODAY).current).toBe(2);
    expect(evaluateCondition({ metric: 'investimento', window: 'hoje', op: 'maior', value: 100 }, series, TODAY).met).toBe(true);
  });
  it('sobe: variação contra a janela anterior', () => {
    const series = [...flat(14, 10, 100).slice(0, 7), ...flat(7, 15, 100)];
    const r = evaluateCondition({ metric: 'investimento', window: '7d', op: 'sobe', value: 30 }, series, TODAY);
    expect(r.value).toBe(50);
    expect(r.met).toBe(true);
  });
  it('cai: compara a queda como número positivo', () => {
    const series = [...flat(14, 10, 100).slice(0, 7), ...flat(7, 7, 100)];
    const r = evaluateCondition({ metric: 'investimento', window: '7d', op: 'cai', value: 20 }, series, TODAY);
    expect(r.value).toBe(30);
    expect(r.met).toBe(true);
  });
  it('sem dados a condição não bate', () => {
    const r = evaluateCondition({ metric: 'acos', window: '7d', op: 'maior', value: 4 }, [], TODAY);
    expect(r).toMatchObject({ value: null, met: false, status: 'ok' });
  });
  it('ACOS acima do alvo usa o alvo da campanha', () => {
    const r = evaluateCondition({ metric: 'acos_vs_alvo', window: '7d', op: 'maior', value: 1 }, flat(7, 5, 100), TODAY, { acosTarget: 3 });
    expect(r.current).toBe(2); // 5% − 3%
    expect(r.met).toBe(true);
  });
});

describe('evaluateRule', () => {
  const tacos: AdCondition = { metric: 'tacos', window: '7d', op: 'maior', value: 4 };
  const cliques: AdCondition = { metric: 'cliques', window: '7d', op: 'maior', value: 50 };

  it('dispara só quando todas as condições batem', () => {
    expect(evaluateRule([tacos, cliques], flat(7, 5, 100), TODAY)).toMatchObject({ fired: true, status: 'estourado' });
    expect(evaluateRule([tacos, { ...cliques, value: 5000 }], flat(7, 5, 100), TODAY).fired).toBe(false);
  });
  it('atenção quando o resto já bateu e falta pouco', () => {
    const r = evaluateRule([tacos, cliques], flat(7, 3.6, 100), TODAY); // TACOS 3,6% (90% do limite)
    expect(r).toMatchObject({ fired: false, status: 'atencao' });
  });
  it('ok longe do limite', () => {
    expect(evaluateRule([tacos], flat(7, 1, 100), TODAY).status).toBe('ok');
  });
  it('mensagem do alerta', () => {
    const msg = ruleMessage('Linha Cozinha', evaluateRule([tacos], flat(7, 5, 100), TODAY));
    expect(msg).toBe('Linha Cozinha: TACOS últimos 7 dias em 5,0% (maior que 4,0%)');
  });
});

describe('canNotify', () => {
  const now = new Date('2026-10-20T12:00:00Z');
  it('respeita o intervalo entre alertas', () => {
    expect(canNotify(null, now, 24)).toBe(true);
    expect(canNotify(new Date('2026-10-20T00:00:00Z'), now, 24)).toBe(false);
    expect(canNotify(new Date('2026-10-19T12:00:00Z'), now, 24)).toBe(true);
  });
});

describe('metas', () => {
  it('período do mês e do ano', () => {
    expect(goalPeriod('gasto_mes', '2026-02-01')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(goalPeriod('gasto_ano', '2026-01-01')).toEqual({ from: '2026-01-01', to: '2026-12-31' });
  });
  it('projeta o mês no ritmo atual', () => {
    // 20 de 31 dias, R$ 23.480 gastos, meta R$ 32.000 → projeção R$ 36.394
    const p = goalPace(32000, 23480, goalPeriod('gasto_mes', '2026-10-01'), TODAY);
    expect(p.projected).toBe(36394);
    expect(p.paceDiff).toBe(13.7);
    expect(p.status).toBe('acima');
    expect(p.idealToDate).toBe(20645.16);
  });
  it('no ritmo e abaixo', () => {
    const period = goalPeriod('gasto_mes', '2026-10-01');
    expect(goalPace(31000, 20000, period, TODAY).status).toBe('no_ritmo');
    expect(goalPace(40000, 20000, period, TODAY).status).toBe('abaixo');
  });
  it('período que ainda não começou fica no ritmo', () => {
    expect(goalPace(1000, 0, goalPeriod('gasto_mes', '2026-11-01'), TODAY)).toMatchObject({ elapsed: 0, status: 'no_ritmo' });
  });
});

describe('simulateRule', () => {
  const rule: AdCondition[] = [{ metric: 'investimento', window: 'ontem', op: 'maior', value: 50 }];
  const series = flat(30, 10, 100).map((d, i) => (i === 10 || i === 11 || i === 25 ? { ...d, cost: 80 } : d));

  it('aponta os dias em que a regra teria avisado', () => {
    // dias caros: 30-10=20 → 2026-09-30, 2026-10-01 e 2026-10-15; "ontem" deles é visto no dia seguinte
    const hits = simulateRule(rule, series, TODAY, 30, 1);
    expect(hits.map((h) => h.day)).toEqual(['2026-10-01', '2026-10-02', '2026-10-16']);
  });
  it('respeita o intervalo entre alertas', () => {
    const hits = simulateRule(rule, series, TODAY, 30, 48);
    expect(hits.map((h) => h.day)).toEqual(['2026-10-01', '2026-10-16']);
  });
});
