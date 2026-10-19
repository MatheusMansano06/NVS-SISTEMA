import { describe, expect, it } from 'vitest';
import { billedWeight, computePricingStudy, priceForStudyMargin, type PricingStudyInput } from './pricing-study.js';

const base: PricingStudyInput = { price: 75.66, cost: 48, feePct: 11.5, taxPct: 4, packaging: 0.5, height: null, width: null, length: null, weightKg: 0.5 };

describe('computePricingStudy', () => {
  it('bate com o Exemplo 1 da planilha (abaixo de R$ 79: custo fixo, sem frete)', () => {
    const r = computePricingStudy(base);
    expect(r.commission).toBe(8.7);
    expect(r.fixedFee).toBe(7.95);
    expect(r.freight).toBe(0);
    expect(r.tax).toBe(3.03);
    expect(r.margin).toBe(7.48);
    expect(r.marginPct!).toBeCloseTo(0.0989, 3);
  });

  it('a partir de R$ 79 cobra frete e zera o custo fixo (inclusive em 79,00 exato)', () => {
    const r = computePricingStudy({ ...base, price: 79, weightKg: 1 });
    expect(r.fixedFee).toBe(0);
    expect(r.freight).toBe(14.15);
    const e2 = computePricingStudy({ ...base, price: 96.88, cost: 66.49, feePct: 13, weightKg: 1 });
    expect(e2.freight).toBe(14.15);
  });

  it('usa o peso cubado quando é maior que o real', () => {
    const w = billedWeight({ height: 4, width: 40, length: 90, weightKg: 0.93 });
    expect(w.cubicKg).toBeCloseTo(2.4);
    expect(w.billedBy).toBe('cubic');
    const r = computePricingStudy({ ...base, price: 100, height: 4, width: 40, length: 90, weightKg: 0.93 });
    expect(r.weightBand).toBe('2 a 3 kg');
    expect(r.freight).toBe(18.35);
  });

  it('sem custo não mostra margem', () => {
    expect(computePricingStudy({ ...base, cost: null }).margin).toBeNull();
  });
});

describe('priceForStudyMargin', () => {
  it('acha o menor preço que entrega a margem, respeitando a faixa do ML', () => {
    const p = priceForStudyMargin(base, 15)!;
    const r = computePricingStudy({ ...base, price: p });
    expect(r.marginPct!).toBeGreaterThanOrEqual(0.15);
    expect(computePricingStudy({ ...base, price: p - 0.01 }).marginPct!).toBeLessThan(0.15);
  });
  it('margem impossível não tem preço', () => {
    expect(priceForStudyMargin(base, 85)).toBeNull();
  });
});
