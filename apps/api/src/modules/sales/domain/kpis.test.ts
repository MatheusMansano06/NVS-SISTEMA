import { describe, expect, it } from 'vitest';
import { computeKpis } from './kpis.js';

describe('computeKpis', () => {
  it('calcula líquido, lucro (custo + imposto), margem e ticket médio', () => {
    const k = computeKpis({ revenue: 1000, fees: 150, cost: 400, tax: 50, orders: 4, units: 6 });
    expect(k).toEqual({
      revenue: 1000,
      net: 850,
      grossProfit: 400,
      margin: 0.4,
      orders: 4,
      units: 6,
      avgTicket: 250,
    });
  });
  it('sem vendas não divide por zero', () => {
    const k = computeKpis({ revenue: 0, fees: 0, cost: 0, tax: 0, orders: 0, units: 0 });
    expect(k.margin).toBe(0);
    expect(k.avgTicket).toBe(0);
  });
});
