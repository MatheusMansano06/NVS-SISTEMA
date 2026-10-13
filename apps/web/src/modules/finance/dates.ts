/** Datas locais (AAAA-MM-DD) para os atalhos de período. */
const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const addDays = (d: Date, n: number) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);

export const PRESETS = [
  { id: 'today', label: 'Hoje' },
  { id: 'yesterday', label: 'Ontem' },
  { id: '7d', label: '7 dias' },
  { id: '30d', label: '30 dias' },
  { id: 'month', label: 'Este mês' },
  { id: 'last_month', label: 'Mês passado' },
] as const;
export type PresetId = (typeof PRESETS)[number]['id'];

export function presetRange(id: PresetId, now = new Date()): { from: string; to: string } {
  const t = addDays(now, 0);
  switch (id) {
    case 'today':
      return { from: iso(t), to: iso(t) };
    case 'yesterday':
      return { from: iso(addDays(t, -1)), to: iso(addDays(t, -1)) };
    case '7d':
      return { from: iso(addDays(t, -6)), to: iso(t) };
    case '30d':
      return { from: iso(addDays(t, -29)), to: iso(t) };
    case 'month':
      return { from: iso(new Date(t.getFullYear(), t.getMonth(), 1)), to: iso(t) };
    case 'last_month':
      return { from: iso(new Date(t.getFullYear(), t.getMonth() - 1, 1)), to: iso(new Date(t.getFullYear(), t.getMonth(), 0)) };
  }
}

export const shortDay = (isoDay: string) => {
  const [, m, d] = isoDay.split('-');
  return `${d}/${m}`;
};
