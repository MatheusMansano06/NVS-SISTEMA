import { describe, expect, it } from 'vitest';
import { DEFAULT_INTERNAL_RATES, computeDifal, interstateRate, paymentGroup } from './sales-analytics.js';

const sp = { originUf: 'SP' as const, imported: false, internalRates: DEFAULT_INTERNAL_RATES };

describe('DIFAL', () => {
  it('alíquota interestadual: Sul/Sudeste → N/NE/CO/ES 7%, demais 12%, importado 4%', () => {
    expect(interstateRate('SP', 'BA', false)).toBe(7);
    expect(interstateRate('SP', 'ES', false)).toBe(7);
    expect(interstateRate('SP', 'PR', false)).toBe(12);
    expect(interstateRate('BA', 'SP', false)).toBe(12);
    expect(interstateRate('SP', 'BA', true)).toBe(4);
  });
  it('venda dentro do estado não paga; fora paga interna − interestadual sobre a base', () => {
    const r = computeDifal([{ uf: 'SP', orders: 2, base: 200 }, { uf: 'BA', orders: 1, base: 100 }, { uf: 'PR', orders: 1, base: 100 }], sp);
    // BA: 20,5 − 7 = 13,5% → 13,50 ; PR: 19,5 − 12 = 7,5% → 7,50
    expect(r.total).toBe(21);
    expect(r.interstateBase).toBe(200);
    expect(r.lines[0]).toMatchObject({ uf: 'BA', rate: 13.5, difal: 13.5 });
    expect(r.lines.find((l) => l.uf === 'SP')!.difal).toBe(0);
  });
  it('agrupa forma de pagamento', () => {
    expect(paymentGroup('bank_transfer')).toBe('pix');
    expect(paymentGroup('account_money')).toBe('balance');
    expect(paymentGroup(null)).toBe('other');
  });
});
