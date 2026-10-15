import { describe, expect, it } from 'vitest';
import { ageInDays, monthlyVisits, salesPerDay } from './viability.js';

describe('monthlyVisits', () => {
  it('soma por mês em ordem cronológica', () => {
    const r = monthlyVisits([
      { date: '2026-06-02T00:00:00Z', total: 5 },
      { date: '2026-05-31T00:00:00Z', total: 3 },
      { date: '2026-06-01T00:00:00Z', total: 2 },
    ]);
    expect(r).toEqual([
      { month: '2026-05', total: 3 },
      { month: '2026-06', total: 7 },
    ]);
  });
});

describe('ageInDays / salesPerDay', () => {
  const now = new Date('2026-10-15T12:00:00Z');
  it('conta os dias desde a criação', () => {
    expect(ageInDays('2026-10-05T12:00:00Z', now)).toBe(10);
  });
  it('anúncio de hoje conta como 1 dia; sem data é null', () => {
    expect(ageInDays('2026-10-15T08:00:00Z', now)).toBe(1);
    expect(ageInDays(null, now)).toBeNull();
    expect(ageInDays('lixo', now)).toBeNull();
  });
  it('média de vendas por dia', () => {
    expect(salesPerDay(100, 30)).toBe(3.33);
    expect(salesPerDay(null, 30)).toBeNull();
    expect(salesPerDay(10, null)).toBeNull();
  });
});
