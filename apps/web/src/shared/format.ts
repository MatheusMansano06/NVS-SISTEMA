const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
const brlCompact = new Intl.NumberFormat('pt-BR', {
  style: 'currency',
  currency: 'BRL',
  notation: 'compact',
  maximumFractionDigits: 1,
});
const integer = new Intl.NumberFormat('pt-BR');

export const money = (n: number) => brl.format(n);
export const compactMoney = (n: number) => brlCompact.format(n);
export const int = (n: number) => integer.format(Math.round(n));
export const pct = (n: number, digits = 1) =>
  `${(n * 100).toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits })}%`;

/** Variação relativa; null quando não há base de comparação. */
export const change = (current: number, previous: number): number | null =>
  previous === 0 ? (current === 0 ? 0 : null) : (current - previous) / Math.abs(previous);
