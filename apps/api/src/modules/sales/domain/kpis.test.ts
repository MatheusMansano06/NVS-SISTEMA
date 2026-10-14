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
      adSpend: 0,
      tacos: 0,
      profitAfterAds: 400,
      marginAfterAds: 0.4,
    });
  });
  it('TACOS = Ads ÷ faturamento; o investimento sai do lucro e da margem', () => {
    const k = computeKpis({ revenue: 1000, fees: 150, cost: 400, tax: 50, orders: 4, units: 6, ads: 80 });
    expect(k).toMatchObject({ adSpend: 80, tacos: 0.08, grossProfit: 400, margin: 0.4, profitAfterAds: 320, marginAfterAds: 0.32 });
  });
  it('sem vendas não divide por zero', () => {
    const k = computeKpis({ revenue: 0, fees: 0, cost: 0, tax: 0, orders: 0, units: 0 });
    expect(k.margin).toBe(0);
    expect(k.avgTicket).toBe(0);
    expect(k.tacos).toBe(0);
  });
});
