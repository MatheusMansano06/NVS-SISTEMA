import { describe, expect, it } from 'vitest';
import { buyerFreightFromCosts, buyerShippingCost, logisticBucket, partialRefund, sellerCoupon, shipmentFreight, shipmentAddress, billedDifal } from './ml-finance.js';

describe('logisticBucket (regra NVS-WMS)', () => {
  it.each([
    [null, 'me1', 'me1'],
    ['fulfillment', 'me2', 'full'],
    ['self_service', 'me2', 'flex'],
    ['drop_off', 'me2', 'places_coleta'],
    ['xd_drop_off', 'me2', 'places_coleta'],
    ['cross_docking', 'me2', 'places_coleta'],
    ['default', 'custom', 'outros'],
  ] as const)('%s/%s → %s', (lt, mode, expected) => expect(logisticBucket(lt, mode)).toBe(expected));
});

describe('frete comprador', () => {
  it('ignora pagamentos não efetivados e usa o maior valor explícito', () => {
    expect(
      buyerShippingCost(
        [
          { status: 'rejected', shipping_cost: 50 },
          { status: 'approved', shipping_cost: 0 },
        ],
        { shipping_option: { cost: 21.9 } },
      ),
    ).toBe(21.9);
  });
  it('Flex subsidiado: usa o "save" do vendedor', () => {
    const costs = { receiver: { save: 0, discounts: [{ type: 'ratio' }] }, senders: [{ user_id: 7, cost: 10, save: 8.5 }] };
    expect(buyerFreightFromCosts(costs, 7, 'self_service')).toBe(8.5);
    expect(buyerFreightFromCosts(costs, 7, 'drop_off')).toBeNull();
  });
  it('frete grátis "loyal": usa o "save" do comprador', () => {
    const costs = { receiver: { save: 12, discounts: [{ type: 'loyal' }] }, senders: [{ user_id: 7, cost: 0 }] };
    expect(buyerFreightFromCosts(costs, 7, 'drop_off')).toBe(12);
  });
});

describe('shipmentFreight', () => {
  it('frete vendedor = custo de tabela − frete comprador', () => {
    const r = shipmentFreight({
      payments: [{ status: 'approved', shipping_cost: 10 }],
      shipment: { logistic_type: 'drop_off', mode: 'me2', shipping_option: { cost: 10, list_cost: 32.5 } },
      costs: null,
      sellerId: 1,
    });
    expect(r).toEqual({ buyer: 10, seller: 22.5, listCost: 32.5, bucket: 'places_coleta', uncertain: false, paidKnown: false });
  });
  it('comprador zerado sem custos do envio → frete incerto (não assume zero)', () => {
    const r = shipmentFreight({ payments: [], shipment: { shipping_option: { cost: 0, list_cost: 20 } }, costs: null, sellerId: 1 });
    expect(r.uncertain).toBe(true);
    expect(r.seller).toBe(20);
  });
});

describe('cupom e devolução', () => {
  it('soma só a parte do vendedor nos cupons', () => {
    expect(
      sellerCoupon({
        details: [
          { type: 'coupon', items: [{ amounts: { seller: 5.5 } }, { amounts: { seller: 2 } }] },
          { type: 'campaign', items: [{ amounts: { seller: 99 } }] },
        ],
      }),
    ).toBe(7.5);
  });
  it('devolução parcial não conta em pedido cancelado', () => {
    const p = [{ transaction_amount_refunded: 30 }];
    expect(partialRefund('paid', p)).toBe(30);
    expect(partialRefund('cancelled', p)).toBe(0);
  });
});

describe('shipmentAddress', () => {
  it('UF de "BR-SP", cidade e CEP', () => {
    expect(
      shipmentAddress({ receiver_address: { zip_code: '04351030', city: { name: 'São Paulo' }, state: { id: 'BR-SP' } } }),
    ).toEqual({ uf: 'SP', city: 'São Paulo', zip: '04351030', lat: null, lng: null });
    expect(shipmentAddress({})).toEqual({ uf: null, city: null, zip: null, lat: null, lng: null });
    expect(shipmentAddress({ receiver_address: { latitude: -23.55, longitude: -46.63 } })).toMatchObject({ lat: -23.55, lng: -46.63 });
  });
});

describe('billedDifal', () => {
  it('soma a linha de DIFAL da fatura e desconta estornos de DIFAL', () => {
    expect(
      billedDifal({
        bill_includes: {
          charges: [
            { label: 'Cobrança do diferencial de alíquota interestadual (ICMS-DIFAL)', amount: 17482.36 },
            { label: 'Cargo por venda', amount: 1000 },
          ],
          bonuses: [{ label: 'Bonificação ICMS-DIFAL', amount: 82.36 }],
        },
      }),
    ).toBe(17400);
    expect(billedDifal({ bill_includes: { charges: [{ label: 'Cargo por venda', amount: 10 }] } })).toBe(0);
  });
});

describe('frete pago pelo vendedor', () => {
  const shipment = { logistic_type: 'drop_off', mode: 'me2', shipping_option: { cost: 0, list_cost: 19.45 } };
  it('usa senders.cost (com desconto de reputação) em vez da tabela', () => {
    const f = shipmentFreight({
      payments: [{ status: 'approved', shipping_cost: 0 }],
      shipment,
      costs: { gross_amount: 19.45, receiver: { save: 0 }, senders: [{ user_id: 7, cost: 14.75, save: 4.7 }] },
      sellerId: 7,
    });
    expect(f).toMatchObject({ seller: 14.75, listCost: 19.45, paidKnown: true });
  });
  it('sem custos do envio, mantém a tabela', () => {
    const f = shipmentFreight({ payments: [], shipment, costs: null, sellerId: 7 });
    expect(f).toMatchObject({ seller: 19.45, paidKnown: false });
  });
  it('Flex continua pela regra antiga', () => {
    const f = shipmentFreight({
      payments: [],
      shipment: { ...shipment, logistic_type: 'self_service' },
      costs: { receiver: { save: 0 }, senders: [{ user_id: 7, cost: 0, save: 0 }] },
      sellerId: 7,
    });
    expect(f.paidKnown).toBe(false);
  });
});
