import { describe, expect, it } from 'vitest';
import { priceForMargin, unitMargin } from './listings.js';

describe('priceForMargin', () => {
  it('encontra o preço que dá a margem alvo (e a conta fecha)', () => {
    const price = priceForMargin({ targetPct: 15, feePct: 12, fixedFee: 0, freight: 7.35, cost: 18, taxPct: 9 })!;
    const m = unitMargin({ price, fee: (price * 12) / 100, freight: 7.35, cost: 18, taxPct: 9, source: 'live' });
    expect(m.pct!).toBeGreaterThanOrEqual(0.1499);
    expect(m.pct!).toBeLessThan(0.152);
  });
  it('margem impossível (soma de % ≥ 100) não tem preço', () => {
    expect(priceForMargin({ targetPct: 80, feePct: 17, fixedFee: 0, freight: 0, cost: 10, taxPct: 9 })).toBeNull();
  });
});
