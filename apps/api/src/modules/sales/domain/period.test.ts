import { describe, expect, it } from 'vitest';
import { granularityOf, previousRange, resolvePeriod, todayIn } from './period.js';

describe('resolvePeriod', () => {
  const today = '2026-10-09';
  it.each([
    ['today', '2026-10-09', '2026-10-09'],
    ['yesterday', '2026-10-08', '2026-10-08'],
    ['7d', '2026-10-03', '2026-10-09'],
    ['30d', '2026-09-10', '2026-10-09'],
    ['this_month', '2026-10-01', '2026-10-09'],
    ['last_month', '2026-09-01', '2026-09-30'],
  ] as const)('%s → %s..%s', (period, from, to) => {
    expect(resolvePeriod(period, today)).toEqual({ from, to });
  });

  it('mês passado em janeiro volta para dezembro do ano anterior', () => {
    expect(resolvePeriod('last_month', '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' });
  });
});

describe('previousRange', () => {
  it('compara 7 dias com os 7 dias anteriores', () => {
    expect(previousRange('7d', { from: '2026-10-03', to: '2026-10-09' })).toEqual({
      from: '2026-09-26',
      to: '2026-10-02',
    });
  });
  it('mês corrente compara com os mesmos dias do mês anterior', () => {
    expect(previousRange('this_month', { from: '2026-10-01', to: '2026-10-09' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-09',
    });
  });
  it('não ultrapassa o fim do mês anterior (31 → 30 dias)', () => {
    expect(previousRange('this_month', { from: '2026-10-01', to: '2026-10-31' })).toEqual({
      from: '2026-09-01',
      to: '2026-09-30',
    });
  });
});

describe('granularidade e fuso', () => {
  it('um dia usa horas; vários dias, dias', () => {
    expect(granularityOf({ from: '2026-10-09', to: '2026-10-09' })).toBe('hour');
    expect(granularityOf({ from: '2026-10-03', to: '2026-10-09' })).toBe('day');
  });
  it('"hoje" respeita o fuso de São Paulo', () => {
    // 01:30 UTC de 10/out ainda é 22:30 de 09/out em São Paulo
    expect(todayIn('America/Sao_Paulo', new Date('2026-10-10T01:30:00Z'))).toBe('2026-10-09');
  });
});
