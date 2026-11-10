/**
 * Número digitado em pt-BR → texto que o `Number()` entende. Vírgula é o decimal ("1.234,56").
 * Sem vírgula, um único ponto seguido de 1 ou 2 dígitos também é decimal ("463.82", "38.00"): quem cola de planilha
 * ou usa o teclado numérico digita ponto, e tratá-lo como milhar gravava o valor multiplicado por 100.
 */
export function normalizeBrNumber(raw: string): string {
  const t = raw.replace(/[R$\s%]/g, '');
  if (t.includes(',')) return t.replace(/\./g, '').replace(',', '.');
  return /^-?\d+\.\d{1,2}$/.test(t) ? t : t.replace(/\./g, '');
}
