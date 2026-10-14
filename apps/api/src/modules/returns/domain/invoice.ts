/**
 * Fatura do ML (portado de central/bi/fatura_ml.py): fecha no dia 12, então o ciclo de uma fatura vai do dia 13 do mês
 * anterior ao dia 12 do mês dela. Chave "AAAA-MM-01". Datas em 'YYYY-MM-DD' (dia UTC, como o original).
 */
export const INVOICE_KEY = /^\d{4}-(0[1-9]|1[0-2])-01$/;

/** Cobranças (C…) e estornos (B…) de tarifa de devolução. Frete de ida (CFFI, CXDI…) fica de fora. */
export const CHARGES: Record<string, string> = {
  CXDID: 'Devolução por envio interno no município',
  CXDED: 'Devolução por envio externo ou intermunicipal',
  CDSDB: 'Tarifa de devolução',
};
export const REFUNDS = ['BXDID', 'BXDED', 'BDSDB'];

const pad = (n: number) => String(n).padStart(2, '0');

/** '2026-09-01' → ['2026-08-13', '2026-09-12']. */
export function cycle(key: string): [string, string] {
  const year = Number(key.slice(0, 4));
  const month = Number(key.slice(5, 7));
  const start = month === 1 ? `${year - 1}-12-13` : `${year}-${pad(month - 1)}-13`;
  return [start, `${year}-${pad(month)}-12`];
}

/** Dia 'YYYY-MM-DD' → chave da fatura em que ele cai. */
export function keyOfDay(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  if (Number(day.slice(8, 10)) <= 12) return `${year}-${pad(month)}-01`;
  return month === 12 ? `${year + 1}-01-01` : `${year}-${pad(month + 1)}-01`;
}

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
export const utcDay = (d: Date) => d.toISOString().slice(0, 10);

/** As últimas `months` chaves de fatura, da atual para trás. */
export function lastKeys(today: string, months: number): string[] {
  const keys: string[] = [];
  let d = today;
  for (let i = 0; i < months; i++) {
    keys.push(keyOfDay(d));
    d = `${cycle(keys[keys.length - 1]!)[0].slice(0, 8)}01`;
  }
  return keys;
}
