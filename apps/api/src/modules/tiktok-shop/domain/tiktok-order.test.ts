import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { signTiktok } from '../infrastructure/tiktok-api.js';
import { compactBreakdown, estimateFee, mapTiktokOrder, readAmounts } from './tiktok-order.js';

// Os exemplos abaixo são respostas reais da API (loja brasileira), sem dados do comprador.
describe('TikTok Shop: pedido', () => {
  const line = { sku_id: 's1', seller_sku: 'ARAREDCAP35X35Preto', product_id: 'p1', product_name: 'Aranha Rede', sku_name: 'Preto', sku_image: 'https://img/1.jpg', original_price: '18.88', seller_discount: '6.39' };

  it('faturado = preço de tabela; desconto do vendedor separado; desconto do TikTok não reduz a receita', () => {
    // mesmo produto: um pedido sem e outro com desconto bancado pelo TikTok (o comprador pagou 12,49 e 8,74)
    const semTiktok = mapTiktokOrder({ id: '1', status: 'AWAITING_SHIPMENT', create_time: 1_794_325_327, shipping_type: 'TIKTOK', line_items: [{ ...line, sale_price: '12.49' }] })!;
    const comTiktok = mapTiktokOrder({ id: '2', status: 'AWAITING_SHIPMENT', create_time: 1_794_325_327, line_items: [{ ...line, sale_price: '8.74', platform_discount: '3.75' }] })!;
    for (const o of [semTiktok, comTiktok]) {
      expect(o.gross).toBe(18.88);
      expect(o.couponSeller).toBe(6.39);
      expect(o.status).toBe('paid');
    }
    expect(semTiktok.items).toEqual([{ sku: 'ARAREDCAP35X35Preto', title: 'Aranha Rede · Preto', quantity: 1, unitPrice: 18.88, listingId: 'p1', pictureUrl: 'https://img/1.jpg' }]);
    expect(semTiktok.listingType).toBe('tiktok_tiktok');
    // provisório: 12,49 × 10% + R$ 4 (a estimativa do TikTok substitui na mesma sincronização)
    expect(semTiktok.fee).toBe(5.25);
  });

  it('agrupa as unidades por SKU (a API manda uma linha por unidade)', () => {
    const o = mapTiktokOrder({
      id: '3', status: 'DELIVERED', create_time: 1_794_325_094,
      line_items: [
        { ...line, sale_price: '15.61', seller_discount: '3.27' },
        { ...line, sale_price: '15.61', seller_discount: '3.27' },
        { ...line, sku_id: 's2', seller_sku: 'ARAREDCAP35X35Vermelho', sku_name: 'Vermelho', sale_price: '15.61', seller_discount: '3.27' },
      ],
    })!;
    expect(o.items.map((i) => [i.sku, i.quantity, i.unitPrice])).toEqual([['ARAREDCAP35X35Preto', 2, 18.88], ['ARAREDCAP35X35Vermelho', 1, 18.88]]);
    expect(o.gross).toBe(56.64);
    expect(o.couponSeller).toBe(9.81);
    expect(o.units).toBe(3);
  });

  it('não pago é ignorado (inclusive cancelado antes do pagamento); cancelado depois de pago não tem tarifa', () => {
    const base = { id: '4', create_time: 1_794_325_094, payment: { total_amount: '12.49' }, line_items: [{ ...line, sale_price: '12.49' }] };
    expect(mapTiktokOrder({ ...base, status: 'UNPAID' })).toBeNull();
    expect(mapTiktokOrder({ ...base, status: 'CANCELLED' })).toBeNull();
    expect(mapTiktokOrder({ ...base, status: 'CANCELLED', paid_time: 1_794_325_100 })).toMatchObject({ status: 'cancelled', fee: 0, gmv: 12.49 });
  });

  it('estimativa provisória muda de faixa em R$ 50', () => {
    expect(estimateFee(49.99, 1)).toBe(9);
    expect(estimateFee(50, 1)).toBe(9);
    expect(estimateFee(100, 2)).toBe(24);
  });
});

describe('TikTok Shop: transação financeira', () => {
  it('repasse de pedido: comissão, frete grátis, tarifa por item e afiliado viram a tarifa; frete subsidiado zera', () => {
    const tx = {
      type: 'ORDER', id: '7695846400508446470', order_id: '586558964089783762',
      revenue_amount: '38.4', fee_tax_amount: '-11.68', settlement_amount: '26.72',
      revenue_breakdown: { subtotal_before_discount_amount: '38.79', seller_discount_amount: '-0.39' },
      fee_tax_breakdown: { fee: { affiliate_commission_amount: '-1.54', fee_per_item_sold_amount: '-4', platform_commission_amount: '-3.84', sfp_service_fee_amount: '-2.3', mall_service_fee_amount: '0' } },
      shipping_cost_breakdown: { actual_shipping_fee_amount: '-16.3', customer_paid_shipping_fee_amount: '1.3', shipping_fee_discount_amount: '15', supplementary_component: { fbm_shipping_cost_amount: '-16.3' } },
    };
    expect(readAmounts(tx)).toEqual({ revenue: 38.4, fee: 11.68, shipping: 0, adjustment: 0, settlement: 26.72, refund: 0, consistent: true });
    expect(compactBreakdown(tx)).toEqual({
      subtotal_before_discount: 38.79, seller_discount: -0.39, actual_shipping_fee: -16.3, customer_paid_shipping_fee: 1.3,
      shipping_fee_discount: 15, affiliate_commission: -1.54, fee_per_item_sold: -4, platform_commission: -3.84, sfp_service_fee: -2.3,
    });
  });

  it('pedido devolvido: devolução já sem o desconto do vendedor; a tarifa que sobrou continua cobrada', () => {
    const a = readAmounts({
      type: 'ORDER', fee_tax_amount: '-1.49', settlement_amount: '-1.49',
      revenue_breakdown: { subtotal_before_discount_amount: '34.98', seller_discount_amount: '-10.14', refund_subtotal_before_discount_amount: '-34.98', seller_discount_refund_amount: '10.14' },
    });
    expect(a).toMatchObject({ revenue: 0, fee: 1.49, refund: 24.84, consistent: true });
  });

  it('ajustes: reembolso é crédito; anúncio descontado das vendas é débito', () => {
    expect(readAmounts({ type: 'PLATFORM_REIMBURSEMENT', adjustment_amount: '19.99', settlement_amount: '19.99' })).toMatchObject({ adjustment: 19.99, fee: 0, consistent: true });
    expect(readAmounts({ type: 'GMV_PAYMENT_FOR_TIKTOK_ADS', adjustment_amount: '-39', settlement_amount: '-39' })).toMatchObject({ adjustment: -39, consistent: true });
  });

  it('pedido sem repasse: usa os valores estimados (est_) do TikTok', () => {
    const a = readAmounts({ type: 'ORDER', order_id: '587103389499426075', est_revenue_amount: '31.22', est_fee_tax_amount: '-12.99', est_settlement_amount: '18.23' }, true);
    expect(a).toMatchObject({ revenue: 31.22, fee: 12.99, shipping: 0, consistent: true });
  });

  it('se a conta só fechar com cobranças positivas, lê assim; se não fechar de jeito nenhum, avisa', () => {
    expect(readAmounts({ revenue_amount: '100', fee_tax_amount: '20', shipping_cost_amount: '5', settlement_amount: '75' })).toMatchObject({ fee: 20, shipping: 5, consistent: true });
    expect(readAmounts({ revenue_amount: '100', fee_tax_amount: '-20', settlement_amount: '50' })).toMatchObject({ fee: 20, consistent: false });
  });
});

describe('TikTok Shop: assinatura', () => {
  it('segredo + caminho + parâmetros ordenados (sem sign e access_token) + corpo + segredo', () => {
    const sign = signTiktok('sec', '/order/202309/orders/search', { timestamp: '1', app_key: 'k', sign: 'x', access_token: 't' }, '{"a":1}');
    const expected = createHmac('sha256', 'sec').update('sec/order/202309/orders/searchapp_keyktimestamp1{"a":1}sec').digest('hex');
    expect(sign).toBe(expected);
  });
});
