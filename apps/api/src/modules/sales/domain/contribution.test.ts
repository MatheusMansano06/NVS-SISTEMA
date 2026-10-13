import { describe, expect, it } from 'vitest';
import { contributionMargin } from './contribution.js';

const base = { produto: 200, freteComprador: 20, freteVendedor: 25, custo: 80, imposto: 18, tarifa: 26, cupom: 0, devolucao: 0 };

describe('contributionMargin (regra NVS-WMS)', () => {
  it('Full/Coleta: frete comprador não entra na base', () => {
    expect(contributionMargin({ ...base, bucket: 'full' })).toEqual({ mc: 51, mcPct: 25.5, faturamentoLinha: 220 });
  });
  it('ME1/outros: vendedor recebe o frete do comprador → entra na base', () => {
    expect(contributionMargin({ ...base, bucket: 'me1' }).mc).toBe(71);
    expect(contributionMargin({ ...base, bucket: 'outros' }).mc).toBe(71);
  });
  it('cupom do vendedor e devolução parcial reduzem a base', () => {
    expect(contributionMargin({ ...base, bucket: 'flex', cupom: 10, devolucao: 5 }).mc).toBe(36);
  });
  it('opção "considerar frete comprador" soma o frete na base em qualquer modalidade', () => {
    expect(contributionMargin({ ...base, bucket: 'full' }, true).mc).toBe(71);
  });
  it('MC% sobre o valor do produto; produto zero não divide', () => {
    expect(contributionMargin({ ...base, produto: 0, bucket: 'full' }).mcPct).toBe(0);
  });
});
