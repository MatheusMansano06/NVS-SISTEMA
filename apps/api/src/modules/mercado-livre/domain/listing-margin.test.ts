import { describe, expect, it } from 'vitest';
import { formatDimensions, logisticOf, unitMargin } from './listing-margin.js';

describe('unitMargin', () => {
  it('preço − tarifa − frete − custo − imposto', () => {
    const m = unitMargin({ price: 100, fee: 14, freight: 20, cost: 30, taxPct: 9, source: 'sales' });
    expect(m.tax).toBe(9);
    expect(m.amount).toBe(27);
    expect(m.pct).toBeCloseTo(0.27);
  });
  it('sem custo a margem é desconhecida, não zero', () => {
    const m = unitMargin({ price: 100, fee: 14, freight: 20, cost: null, taxPct: 9, source: 'sales' });
    expect(m.amount).toBeNull();
    expect(m.pct).toBeNull();
  });
});

describe('logisticOf / formatDimensions', () => {
  it('mapeia a logística do ML', () => {
    expect(logisticOf('fulfillment')).toBe('full');
    expect(logisticOf('self_service')).toBe('flex');
    expect(logisticOf('cross_docking')).toBe('collect');
    expect(logisticOf(null)).toBe('standard');
  });
  it('formata dimensões', () => {
    expect(formatDimensions('27x20x13,305')).toBe('27 x 20 x 13 cm · 305 g');
    expect(formatDimensions('lixo')).toBeNull();
  });
});
