/** Regras das mensalidades do NVS Tech (cupom, vencimento, atraso). Datas em 'YYYY-MM-DD'. */
export interface CouponRule {
  kind: 'percent' | 'fixed';
  value: number;
  duration: 'once' | 'months' | 'forever';
  months: number | null;
  maxRedemptions: number | null;
  redemptions: number;
  validUntil: string | null;
  active: boolean;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Desconto do cupom sobre o valor (nunca maior que o valor). */
export function discountFor(amount: number, c: Pick<CouponRule, 'kind' | 'value'>): number {
  const d = c.kind === 'percent' ? (amount * c.value) / 100 : c.value;
  return round2(Math.min(amount, Math.max(0, d)));
}

/** Por que o cupom não pode ser usado agora (null = pode). */
export function couponProblem(c: CouponRule, today: string): string | null {
  if (!c.active) return 'Cupom desativado.';
  if (c.validUntil && c.validUntil < today) return 'Cupom vencido.';
  if (c.maxRedemptions !== null && c.redemptions >= c.maxRedemptions) return 'Cupom já atingiu o limite de usos.';
  return null;
}

/** Quantas mensalidades o cupom desconta (null = todas). */
export function cyclesFor(c: Pick<CouponRule, 'duration' | 'months'>): number | null {
  return c.duration === 'once' ? 1 : c.duration === 'months' ? (c.months ?? 1) : null;
}

/** Vencimento da mensalidade do mês `period` (1º dia) no dia de cobrança da assinatura. */
export function dueDateOf(period: string, billingDay: number): string {
  return `${period.slice(0, 8)}${String(Math.min(28, Math.max(1, billingDay))).padStart(2, '0')}`;
}

/** Situação mostrada: paga, cancelada, em atraso (pendente vencida) ou a vencer. */
export function invoiceSituation(status: 'pending' | 'paid' | 'canceled', dueDate: string, today: string): 'paid' | 'canceled' | 'overdue' | 'pending' {
  if (status !== 'pending') return status;
  return dueDate < today ? 'overdue' : 'pending';
}

export const monthKey = (day: string) => `${day.slice(0, 7)}-01`;
