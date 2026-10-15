import { describe, expect, it } from 'vitest';
import { ageInDays, estimateError, estimateTime, mlbNumber, monthlyVisits, prepareAnchors, salesPerDay, type IdAnchor } from './viability.js';

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

describe('estimativa da data pelo número do anúncio', () => {
  const day = 86_400_000;
  const t0 = Date.parse('2025-01-01T00:00:00Z');
  // 1 anúncio a cada 1000 números por dia, com uma referência fora da curva
  const raw: IdAnchor[] = [0, 10, 20, 30, 40, 50].map((d) => ({ id: 5_000_000_000 + d * 1000, t: t0 + d * day }));
  raw.push({ id: 5_000_025_000, t: t0 + 400 * day }); // data errada
  const now = t0 + 365 * day;

  it('mlbNumber aceita MLB123 e MLB-123', () => {
    expect(mlbNumber('MLB5000001000')).toBe(5_000_001_000);
    expect(mlbNumber('MLB-5000001000')).toBe(5_000_001_000);
    expect(mlbNumber('MLBU123')).toBeNull();
  });
  it('interpola entre vizinhos e ignora a referência fora da curva', () => {
    const a = prepareAnchors(raw);
    expect(estimateTime(5_000_015_000, a, now)).toBe(t0 + 15 * day);
    for (let i = 1; i < a.length; i++) expect(a[i]!.t).toBeGreaterThanOrEqual(a[i - 1]!.t);
  });
  it('extrapola nas pontas e nunca passa de agora', () => {
    const a = prepareAnchors(raw.slice(0, 6));
    expect(estimateTime(5_000_060_000, a, now)).toBe(t0 + 60 * day);
    expect(estimateTime(9_000_000_000, a, now)).toBe(now);
    expect(estimateTime(1, [a[0]!], now)).toBeNull();
  });
  it('mede o erro deixando uma referência de fora', () => {
    const e = estimateError(raw.slice(0, 6), now)!;
    expect(e.n).toBe(6);
    expect(e.medianDays).toBe(0);
  });
});
