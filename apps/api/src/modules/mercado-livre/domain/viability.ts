const DAY_MS = 86_400_000;

/** Soma as visitas diárias por mês (AAAA-MM), em ordem cronológica. */
export function monthlyVisits(daily: { date: string; total: number }[]): { month: string; total: number }[] {
  const byMonth = new Map<string, number>();
  for (const d of daily) {
    const month = d.date.slice(0, 7);
    byMonth.set(month, (byMonth.get(month) ?? 0) + (d.total ?? 0));
  }
  return [...byMonth.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([month, total]) => ({ month, total }));
}

/** Dias de vida do anúncio (mínimo 1, para a média não dividir por zero); null sem data. */
export function ageInDays(createdAt: string | null | undefined, now: Date): number | null {
  if (!createdAt) return null;
  const t = Date.parse(createdAt);
  if (Number.isNaN(t)) return null;
  return Math.max(1, Math.floor((now.getTime() - t) / DAY_MS));
}

/** Média de vendas por dia de vida (2 casas); null se faltar vendas ou idade. */
export function salesPerDay(sold: number | null | undefined, ageDays: number | null): number | null {
  if (sold == null || ageDays == null) return null;
  return Math.round((sold / ageDays) * 100) / 100;
}
