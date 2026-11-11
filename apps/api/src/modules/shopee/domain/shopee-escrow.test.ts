import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { mapShopeeEscrow, orderFinance, type ShopeeEscrowDetail } from './shopee-escrow.js';

const dir = resolve(import.meta.dirname, 'fixtures');
/** Escrows reais da loja (NVS W2, identificadores pseudonimizados, sem dados do comprador). */
const real: ShopeeEscrowDetail[] = readFileSync(resolve(dir, 'escrow-real.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));
const bySn = (sn: string) => structuredClone(real.find((e) => e.order_sn === sn)!);
const devolucao: ShopeeEscrowDetail = JSON.parse(readFileSync(resolve(dir, 'escrow-devolucao.json'), 'utf8'));

/** Margem do jeito da Análise Financeira (bucket "outros": frete do comprador entra na base), sem custo e imposto. */
const margin = (f: ReturnType<typeof orderFinance>) => Math.round((f.gross + f.buyerShipping - f.coupon - f.refund - f.fee - f.shipping) * 100) / 100;

describe('escrow da Shopee → canônico NVS (gabarito do NVS W2)', () => {
  it('lê o repasse dos quatro pedidos reais', () => {
    expect(Object.fromEntries(real.map((e) => [e.order_sn, mapShopeeEscrow(e).escrow_amount]))).toEqual({
      'SHP-FIX-001': 53.91, 'SHP-FIX-002': 53.91, 'SHP-FIX-003': 17.89, 'SHP-FIX-004': 62.04,
    });
  });

  it('tarifa bruta soma as seis rubricas, inclusive o Ads, e guarda cada uma', () => {
    const m = mapShopeeEscrow(bySn('SHP-FIX-004'));
    expect(m.tarifas.ads_fee).toBe(1.88);
    expect(m.tarifa).toBe(31.97);
    expect(Object.values(m.tarifas).reduce((s, v) => s + v, 0)).toBeCloseTo(31.97, 2);
  });

  it('comissão de afiliado entra na tarifa sem tirar o Ads', () => {
    const e = bySn('SHP-FIX-004');
    const inc = e.order_income as Record<string, number> & { escrow_amount: number; escrow_amount_after_adjustment: number };
    inc.order_ams_commission_fee = 21.56;
    inc.escrow_amount -= 21.56;
    inc.escrow_amount_after_adjustment -= 21.56;
    const m = mapShopeeEscrow(e);
    expect(m.tarifas.affiliate_commission_fee).toBe(21.56);
    expect(m.tarifa).toBe(53.53);
  });

  it('frete do vendedor é o real menos o subsídio da Shopee', () => {
    const m = mapShopeeEscrow(bySn('SHP-FIX-001'));
    expect(m.frete_vendedor).toBe(1.44);
    expect(m.frete_comprador).toBe(1.44);
  });

  it('crédito do desconto da Shopee é líquido do desconto Pix (sem somar o rebate do produto)', () => {
    expect(mapShopeeEscrow(bySn('SHP-FIX-002')).tarifa_refund).toBe(15.46);
    expect(mapShopeeEscrow(bySn('SHP-FIX-001')).tarifa_refund).toBe(15.46);
  });

  it('cupom do vendedor soma o voucher e o desconto extra', () => {
    expect(mapShopeeEscrow(bySn('SHP-FIX-004')).cupom).toBe(2.97);
  });

  it('retenções ficam fora da tarifa', () => {
    expect(mapShopeeEscrow(bySn('SHP-FIX-003')).tarifa).toBe(11.5);
  });

  it('a margem do pedido fecha com o repasse (MC = repasse − custo − imposto)', () => {
    for (const e of real) {
      const m = mapShopeeEscrow(e);
      expect(margin(orderFinance(m, m.produto))).toBe(m.escrow_amount);
    }
  });

  it('entrega feita pelo vendedor: o crédito de frete fica reservado, sem lucro fictício', () => {
    const e = bySn('SHP-FIX-001');
    const inc = e.order_income as Record<string, number> & { escrow_amount: number; escrow_amount_after_adjustment: number };
    inc.buyer_paid_shipping_fee = 0;
    inc.actual_shipping_fee = 0;
    inc.final_shipping_fee = 10;
    inc.shopee_shipping_rebate = 10;
    inc.escrow_amount += 10;
    const m = mapShopeeEscrow(e);
    expect(m.quality_flags).toContain('direct_delivery_cost_unknown');
    expect(margin(orderFinance(m, m.produto))).toBeCloseTo(m.escrow_amount - 10, 2);
  });

  it('devolvido com reembolso vira devolução, e a margem é o que a Shopee repassou depois dos ajustes', () => {
    const m = mapShopeeEscrow(devolucao);
    expect(m.returned).toBe(true);
    const f = orderFinance(m, 79.99);
    expect(f.status).toBe('returned');
    expect(f.refund).toBe(79.99);
    expect(margin(f)).toBe(m.escrow_after_adjustment);
  });

  it('não guarda a lista de itens no escrow bruto', () => {
    expect(mapShopeeEscrow(bySn('SHP-FIX-001')).income).not.toHaveProperty('items');
  });
});
