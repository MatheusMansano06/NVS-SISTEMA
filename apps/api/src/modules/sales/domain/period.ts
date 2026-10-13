import type { Period } from '@nvs/shared';

export const TIMEZONE = 'America/Sao_Paulo';

/** Intervalo de datas locais (YYYY-MM-DD), `to` inclusivo. */
export interface DateRange {
  from: string;
  to: string;
}

const toDate = (iso: string) => new Date(`${iso}T00:00:00Z`);
const toIso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (iso: string, days: number) => {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + days);
  return toIso(d);
};
const daysBetween = (a: string, b: string) =>
  Math.round((toDate(b).getTime() - toDate(a).getTime()) / 86_400_000);

/** "Hoje" no fuso de São Paulo, independentemente do fuso do servidor. */
export function todayIn(timeZone = TIMEZONE, now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}

export function resolvePeriod(period: Period, today: string): DateRange {
  switch (period) {
    case 'today':
      return { from: today, to: today };
    case 'yesterday':
      return { from: addDays(today, -1), to: addDays(today, -1) };
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'this_month':
      return { from: `${today.slice(0, 7)}-01`, to: today };
    case 'last_month': {
      const firstThis = `${today.slice(0, 7)}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
  }
}

/**
 * Período anterior para comparação. Mês corrente compara com os mesmos dias do mês
 * anterior; os demais, com o intervalo de mesmo tamanho imediatamente antes.
 */
export function previousRange(period: Period, range: DateRange): DateRange {
  if (period === 'this_month' || period === 'last_month') {
    const firstPrev = addDays(range.from, -1).slice(0, 7) + '-01';
    const span = daysBetween(range.from, range.to);
    const lastOfPrev = addDays(range.from, -1);
    const to = addDays(firstPrev, span);
    return { from: firstPrev, to: to > lastOfPrev ? lastOfPrev : to };
  }
  const span = daysBetween(range.from, range.to) + 1;
  return { from: addDays(range.from, -span), to: addDays(range.from, -1) };
}

export const granularityOf = (range: DateRange): 'hour' | 'day' =>
  range.from === range.to ? 'hour' : 'day';
