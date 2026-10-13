/** Mantém apenas dígitos. */
export const onlyDigits = (value: string): string => value.replace(/\D/g, '');

/** Valida CNPJ pelos dígitos verificadores (rejeita sequências repetidas). */
export function isValidCnpj(input: string): boolean {
  const cnpj = onlyDigits(input);
  if (cnpj.length !== 14 || /^(\d)\1+$/.test(cnpj)) return false;
  const check = (len: number): number => {
    const weights = len === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const sum = weights.reduce((acc, w, i) => acc + Number(cnpj[i]) * w, 0);
    const rest = sum % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  return check(12) === Number(cnpj[12]) && check(13) === Number(cnpj[13]);
}

export function formatCnpj(input: string): string {
  const d = onlyDigits(input).padEnd(14, ' ').slice(0, 14);
  return d.replace(/^(.{2})(.{3})(.{3})(.{4})(.{2})$/, '$1.$2.$3/$4-$5').trim();
}
