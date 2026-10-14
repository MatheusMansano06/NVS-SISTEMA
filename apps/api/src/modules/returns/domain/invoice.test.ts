import { describe, expect, it } from 'vitest';
import { INVOICE_KEY, cycle, keyOfDay, lastKeys } from './invoice.js';

describe('fatura do ML (ciclo do dia 13 ao 12)', () => {
  it('monta o ciclo e acha a fatura de um dia', () => {
    expect(cycle('2026-09-01')).toEqual(['2026-08-13', '2026-09-12']);
    expect(cycle('2026-01-01')).toEqual(['2025-12-13', '2026-01-12']);
    expect(keyOfDay('2026-09-12')).toBe('2026-09-01');
    expect(keyOfDay('2026-09-13')).toBe('2026-10-01');
    expect(keyOfDay('2026-12-20')).toBe('2027-01-01');
  });

  it('lista as últimas faturas e valida a chave', () => {
    expect(lastKeys('2026-10-14', 3)).toEqual(['2026-11-01', '2026-10-01', '2026-09-01']);
    expect(lastKeys('2026-01-05', 2)).toEqual(['2026-01-01', '2025-12-01']);
    expect(INVOICE_KEY.test('2026-09-01')).toBe(true);
    expect(INVOICE_KEY.test('2026-13-01')).toBe(false);
    expect(INVOICE_KEY.test('2026-09-02')).toBe(false);
  });
});
