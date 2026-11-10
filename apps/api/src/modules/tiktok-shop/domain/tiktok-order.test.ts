import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signTiktok } from '../infrastructure/tiktok-api.js';
import { estimateFee, mapTiktokOrder, parseSettlement } from './tiktok-order.js';

describe('TikTok Shop: pedido', () => {
  const order = {
    id: '577',
    status: 'DELIVERED',
    create_time: 1_780_000_000,
    line_items: [
      { sku_id: 's1', seller_sku: 'CANECA-01', product_id: 'p1', product_name: 'Caneca', sale_price: '35.00', platform_discount: '5.00' },
      { sku_id: 's1', seller_sku: 'CANECA-01', product_id: 'p1', product_name: 'Caneca', sale_price: '35.00', platform_discount: '5.00' },
      { sku_id: 's2', seller_sku: 'GARRAFA-02', product_id: 'p2', product_name: 'Garrafa', sale_price: '80.00' },
    ],
  };

  it('agrupa as unidades por SKU e soma o desconto bancado pelo TikTok à receita', () => {
    const o = mapTiktokOrder(order)!;
    expect(o.items).toEqual([
      { sku: 'CANECA-01', title: 'Caneca', quantity: 2, unitPrice: 40, listingId: 'p1' },
      { sku: 'GARRAFA-02', title: 'Garrafa', quantity: 1, unitPrice: 80, listingId: 'p2' },
    ]);
    expect(o.gross).toBe(160);
    expect(o.units).toBe(3);
    // 2 × (40 × 10% + 4) + (80 × 6% + 6)
    expect(o.fee).toBe(26.8);
    expect(o.status).toBe('paid');
  });

  it('não pago é ignorado; cancelado não tem tarifa', () => {
    expect(mapTiktokOrder({ ...order, status: 'UNPAID' })).toBeNull();
    const c = mapTiktokOrder({ ...order, status: 'CANCELLED' })!;
    expect(c.status).toBe('cancelled');
    expect(c.fee).toBe(0);
  });

  it('estimativa muda de faixa em R$ 50', () => {
    expect(estimateFee(49.99, 1)).toBe(9);
    expect(estimateFee(50, 1)).toBe(9);
    expect(estimateFee(100, 2)).toBe(24);
  });
});

describe('TikTok Shop: extrato do pedido', () => {
  it('sem transações = ainda não repassado', () => {
    expect(parseSettlement({ statement_transactions: [] })).toBeNull();
    expect(parseSettlement(null)).toBeNull();
  });

  it('soma as transações (cobranças negativas viram valor positivo)', () => {
    const s = parseSettlement({
      statement_transactions: [
        { fee_and_tax_amount: '-12.50', shipping_cost_amount: '-8.00' },
        { fee_and_tax_amount: '-1.50', shipping_cost_amount: '3.00' },
      ],
    });
    expect(s).toEqual({ fee: 14, shipping: 5 });
  });

  it('prefere os totais do pedido quando vêm prontos; frete a favor do vendedor vira 0', () => {
    const s = parseSettlement({ fee_and_tax_amount: '-20', shipping_cost_amount: '4', statement_transactions: [{ fee_and_tax_amount: '-1' }] });
    expect(s).toEqual({ fee: 20, shipping: 0 });
  });
});

describe('TikTok Shop: assinatura', () => {
  it('segredo + caminho + parâmetros ordenados (sem sign e access_token) + corpo + segredo', () => {
    const sign = signTiktok('sec', '/order/202309/orders/search', { timestamp: '1', app_key: 'k', sign: 'x', access_token: 't' }, '{"a":1}');
    const expected = createHmac('sha256', 'sec').update('sec/order/202309/orders/searchapp_keyktimestamp1{"a":1}sec').digest('hex');
    expect(sign).toBe(expected);
  });
});
