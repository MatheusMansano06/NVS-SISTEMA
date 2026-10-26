import { z } from 'zod';

// ================= Curva ABC dos anúncios
// Fila do maior para o menor; o acumulado decide a classe: A até 80% do total, B até 95%, C o resto.

export const ABC_PERIODS = ['30d', '60d', '90d'] as const;
export type AbcPeriod = (typeof ABC_PERIODS)[number];
export const ABC_PERIOD_DAYS: Record<AbcPeriod, number> = { '30d': 30, '60d': 60, '90d': 90 };

export const ABC_METRICS = ['revenue', 'units'] as const;
export type AbcMetric = (typeof ABC_METRICS)[number];

export const ABC_CLASSES = ['A', 'B', 'C'] as const;
export type AbcClass = (typeof ABC_CLASSES)[number];

/** Limites do acumulado, em % do total. */
export const ABC_LIMITS = { A: 80, B: 95 } as const;

export const abcQuerySchema = z.object({ period: z.enum(ABC_PERIODS).default('30d') });

export interface AbcPositionDto {
  /** 1 = o que mais vendeu. */
  rank: number;
  /** Participação no total (0–1). */
  share: number;
  /** Acumulado até este anúncio (0–1), arredondado PARA CIMA em 0,1% — o número mostrado nunca contradiz a classe. */
  cumulative: number;
  class: AbcClass;
}

export interface AbcItemDto {
  listingId: string;
  title: string;
  pictureUrl: string | null;
  permalink: string | null;
  revenue: number;
  units: number;
  byRevenue: AbcPositionDto;
  byUnits: AbcPositionDto;
}

export interface AbcClassSummaryDto {
  listings: number;
  /** Faturamento (R$) ou unidades da classe. */
  value: number;
  share: number;
}

export interface AbcCurveDto {
  range: { from: string; to: string };
  totals: { listings: number; revenue: number; units: number };
  summary: Record<AbcMetric, Record<AbcClass, AbcClassSummaryDto>>;
  items: AbcItemDto[];
}

/**
 * Classifica valores inteiros (centavos ou unidades) — conta exata, sem erro de arredondamento nos limites.
 * Ordena do maior para o menor (empate: `tie`, depois a ordem recebida). A = acumulado ≤ 80% do total,
 * B = ≤ 95%, C = o resto. Exceção: o primeiro da fila é sempre A (sozinho ele pode passar de 80%).
 */
export function classifyAbc<T>(items: T[], value: (t: T) => number, tie: (a: T, b: T) => number = () => 0): Map<T, AbcPositionDto> {
  const sorted = items.map((t, i) => ({ t, i })).sort((a, b) => value(b.t) - value(a.t) || tie(a.t, b.t) || a.i - b.i);
  const total = sorted.reduce((s, x) => s + value(x.t), 0);
  const out = new Map<T, AbcPositionDto>();
  let acc = 0;
  sorted.forEach(({ t }, i) => {
    const v = value(t);
    acc += v;
    const cls: AbcClass = i === 0 || acc * 100 <= ABC_LIMITS.A * total ? 'A' : acc * 100 <= ABC_LIMITS.B * total ? 'B' : 'C';
    out.set(t, {
      rank: i + 1,
      share: total ? v / total : 0,
      cumulative: total ? Math.ceil((acc * 1000) / total) / 1000 : 0,
      class: cls,
    });
  });
  return out;
}
