import { describe, expect, it } from 'vitest';
import { hasWholesale } from './marketing-service.js';

describe('hasWholesale', () => {
  it('reconhece faixas por quantidade e preço para empresa', () => {
    expect(hasWholesale({ prices: [{ type: 'standard', amount: 10 }] })).toBe(false);
    expect(hasWholesale({ prices: [{ type: 'standard', amount: 10 }, { type: 'standard', amount: 9, conditions: { min_purchase_unit: 5 } }] })).toBe(true);
    expect(hasWholesale({ prices: [{ amount: 9, conditions: { context_restrictions: ['channel_marketplace', 'user_type_business'] } }] })).toBe(true);
    expect(hasWholesale(null)).toBe(false);
  });
});
