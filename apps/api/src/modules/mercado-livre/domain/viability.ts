const DAY_MS = 86_400_000;

/** Visitas por dia em ordem cronológica (o ML devolve do mais novo para o mais antigo). */
export function dailyVisits(results: { date: string; total?: number | null }[] | null | undefined): { date: string; total: number }[] {
  return (results ?? []).map((r) => ({ date: r.date.slice(0, 10), total: r.total ?? 0 })).sort((a, b) => a.date.localeCompare(b.date));
}

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

// ---------------------------------------------------------------- data de criação estimada pelo número do anúncio
// O ML numera os anúncios (MLB…) em sequência no site inteiro: com anúncios de data conhecida como referência,
// a data de qualquer outro sai por interpolação entre os vizinhos de número.

export interface IdAnchor {
  id: number;
  t: number; // epoch ms
}

const EDGE = 15; // referências usadas para extrapolar além das pontas

/** Número do anúncio ("MLB123" → 123); null se não for um anúncio MLB comum. */
export function mlbNumber(id: string): number | null {
  const m = /^MLB-?(\d{6,15})$/i.exec(id.trim());
  return m ? Number(m[1]) : null;
}

/**
 * Prepara as referências: ordena pelo número e força a data a nunca voltar no tempo (regressão isotônica,
 * "pool adjacent violators"), o que absorve anúncios com data fora da curva.
 */
export function prepareAnchors(raw: IdAnchor[]): IdAnchor[] {
  const sorted = [...raw].sort((a, b) => a.id - b.id);
  const blocks: { sum: number; n: number; ids: number[] }[] = [];
  for (const a of sorted) {
    blocks.push({ sum: a.t, n: 1, ids: [a.id] });
    while (blocks.length > 1 && blocks[blocks.length - 2]!.sum / blocks[blocks.length - 2]!.n > blocks[blocks.length - 1]!.sum / blocks[blocks.length - 1]!.n) {
      const last = blocks.pop()!;
      const prev = blocks[blocks.length - 1]!;
      prev.sum += last.sum;
      prev.n += last.n;
      prev.ids.push(...last.ids);
    }
  }
  return blocks.flatMap((b) => b.ids.map((id) => ({ id, t: b.sum / b.n })));
}

function slope(a: IdAnchor, b: IdAnchor): number {
  return b.id === a.id ? 0 : (b.t - a.t) / (b.id - a.id);
}

/** Data estimada (epoch ms) para o número `id`, a partir de referências já preparadas; null sem referências suficientes. */
export function estimateTime(id: number, anchors: IdAnchor[], now: number): number | null {
  if (anchors.length < 2) return null;
  let lo = 0;
  let hi = anchors.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (anchors[mid]!.id < id) lo = mid + 1;
    else hi = mid;
  }
  let t: number;
  if (lo < anchors.length && anchors[lo]!.id === id) t = anchors[lo]!.t;
  else if (lo === 0) t = anchors[0]!.t + slope(anchors[0]!, anchors[Math.min(EDGE, anchors.length - 1)]!) * (id - anchors[0]!.id);
  else if (lo === anchors.length) {
    const last = anchors[anchors.length - 1]!;
    t = last.t + slope(anchors[Math.max(0, anchors.length - 1 - EDGE)]!, last) * (id - last.id);
  } else {
    const a = anchors[lo - 1]!;
    const b = anchors[lo]!;
    t = a.t + slope(a, b) * (id - a.id);
  }
  return Math.min(t, now);
}

/** Erro da estimativa medido nas próprias referências (deixa uma de fora por vez), em dias. */
export function estimateError(raw: IdAnchor[], now: number, sample = 300): { n: number; medianDays: number; p90Days: number } | null {
  if (raw.length < 5) return null;
  const step = Math.max(1, Math.floor(raw.length / sample));
  const errors: number[] = [];
  for (let i = 0; i < raw.length; i += step) {
    const rest = prepareAnchors(raw.filter((_, j) => j !== i));
    const est = estimateTime(raw[i]!.id, rest, now);
    if (est !== null) errors.push(Math.abs(est - raw[i]!.t) / 86_400_000);
  }
  errors.sort((a, b) => a - b);
  const q = (p: number) => Math.round(errors[Math.min(errors.length - 1, Math.floor(p * errors.length))]! * 10) / 10;
  return { n: errors.length, medianDays: q(0.5), p90Days: q(0.9) };
}
