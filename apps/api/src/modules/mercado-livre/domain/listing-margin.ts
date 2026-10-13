import type { ListingDto } from '@nvs/shared';

export { unitMargin } from '@nvs/shared';

export function logisticOf(type: string | null): ListingDto['logistic'] {
  if (type === 'fulfillment') return 'full';
  if (type === 'self_service') return 'flex';
  if (type === 'xd_drop_off' || type === 'drop_off') return 'agency';
  if (type === 'cross_docking') return 'collect';
  return 'standard';
}

export function typeLabel(id: string | null): string | null {
  if (id === 'gold_special') return 'Clássico';
  if (id === 'gold_pro') return 'Premium';
  if (id === 'free') return 'Grátis';
  return id;
}

/** "27x20x13,305" (LxAxC cm, peso g) → "27 x 20 x 13 cm · 305 g". */
export function formatDimensions(raw: string | null): string | null {
  if (!raw) return null;
  const m = /^(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?),(\d+(?:\.\d+)?)$/.exec(raw.trim());
  if (!m) return null;
  const [, a, b, c, w] = m;
  return `${a} x ${b} x ${c} cm · ${Number(w)} g`;
}
