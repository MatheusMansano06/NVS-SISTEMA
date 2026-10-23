import { describe, expect, it } from 'vitest';
import { compareProductRadar, productRadarListingSchema, summarizeProductRadar } from './product-radar.js';

const listing = (salesPerDay: number, passSales: boolean, passReviews: boolean, thumbnail: string | null = null) =>
  productRadarListingSchema.parse({ title: `Anúncio ${salesPerDay}`, salesPerDay, passSales, passReviews, thumbnail });

describe('summarizeProductRadar', () => {
  it('aprovado só passa nos dois; líder e capa vêm do aprovado que mais vende', () => {
    const s = summarizeProductRadar([
      listing(56, true, false, 'https://x/a.jpg'),
      listing(14.8, true, true, 'https://x/b.jpg'),
      listing(2.5, true, true),
      listing(0.6, false, false),
    ]);
    expect(s).toMatchObject({ analyzed: 4, passSales: 3, passReviews: 2, approved: 2, leaderSalesPerDay: 14.8, thumbnail: 'https://x/b.jpg' });
    expect(s.listings.map((l) => l.approved)).toEqual([false, true, true, false]);
  });

  it('sem aprovado: líder zerado e capa do que mais vende', () => {
    const s = summarizeProductRadar([listing(3, true, false, 'https://x/c.jpg'), listing(9, true, false, 'https://x/d.jpg')]);
    expect(s).toMatchObject({ approved: 0, leaderSalesPerDay: 0, thumbnail: 'https://x/d.jpg' });
  });
});

describe('compareProductRadar', () => {
  it('ordena por veredito, aprovados e vendas/dia do líder', () => {
    const rows = [
      { id: 'c', verdict: 'arriscado' as const, approved: 4, leaderSalesPerDay: 300 },
      { id: 'b', verdict: 'viavel' as const, approved: 6, leaderSalesPerDay: 20 },
      { id: 'a', verdict: 'viavel' as const, approved: 6, leaderSalesPerDay: 90 },
      { id: 'd', verdict: 'viavel' as const, approved: 8, leaderSalesPerDay: 5 },
    ];
    expect(rows.sort(compareProductRadar).map((r) => r.id)).toEqual(['d', 'a', 'b', 'c']);
  });
});
