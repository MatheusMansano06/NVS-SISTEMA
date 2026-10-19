/** Número digitado em pt-BR ("1.234,56", "R$ 10", "12%") → number; vazio/ inválido → null. */
export const parse = (s: string): number | null => {
  const t = s.replace(/[R$\s%]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
};

export const toInput = (n: number | null | undefined, digits = 2) =>
  n == null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: digits, maximumFractionDigits: digits });
