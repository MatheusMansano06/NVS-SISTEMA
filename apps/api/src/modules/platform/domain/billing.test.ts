import { describe, expect, it } from 'vitest';
import { couponProblem, cyclesFor, discountFor, dueDateOf, invoiceSituation, type CouponRule } from './billing.js';

const coupon = (p: Partial<CouponRule> = {}): CouponRule => ({
  kind: 'percent', value: 20, duration: 'once', months: null, maxRedemptions: null, redemptions: 0, validUntil: null, active: true, ...p,
});

describe('mensalidades e cupons', () => {
  it('desconto percentual ou fixo, nunca maior que o valor', () => {
    expect(discountFor(199.9, { kind: 'percent', value: 20 })).toBe(39.98);
    expect(discountFor(199.9, { kind: 'fixed', value: 50 })).toBe(50);
    expect(discountFor(30, { kind: 'fixed', value: 50 })).toBe(30);
  });

  it('cupom inválido diz o motivo', () => {
    expect(couponProblem(coupon(), '2026-10-14')).toBeNull();
    expect(couponProblem(coupon({ active: false }), '2026-10-14')).toMatch(/desativado/);
    expect(couponProblem(coupon({ validUntil: '2026-10-13' }), '2026-10-14')).toMatch(/vencido/);
    expect(couponProblem(coupon({ maxRedemptions: 3, redemptions: 3 }), '2026-10-14')).toMatch(/limite/);
  });

  it('ciclos de desconto, vencimento e atraso', () => {
    expect(cyclesFor({ duration: 'once', months: null })).toBe(1);
    expect(cyclesFor({ duration: 'months', months: 3 })).toBe(3);
    expect(cyclesFor({ duration: 'forever', months: null })).toBeNull();
    expect(dueDateOf('2026-11-01', 10)).toBe('2026-11-10');
    expect(dueDateOf('2026-02-01', 31)).toBe('2026-02-28');
    expect(invoiceSituation('pending', '2026-10-10', '2026-10-14')).toBe('overdue');
    expect(invoiceSituation('pending', '2026-10-20', '2026-10-14')).toBe('pending');
    expect(invoiceSituation('paid', '2026-10-10', '2026-10-14')).toBe('paid');
  });
});
