import { describe, expect, it } from 'vitest';
import { feeBonusOf, mapMlItem, mapMlOrder, sellerSku, type MlOrder } from './ml-order.js';

const base: MlOrder = {
  id: 2000001,
  status: 'paid',
  date_created: '2026-10-10T14:30:00.000-03:00',
  total_amount: 239.8,
  order_items: [
    { item: { id: 'MLB123', title: 'Kit Relação CG 160', seller_sku: 'KIT-CG160' }, quantity: 2, unit_price: 119.9, sale_fee: 15.59 },
  ],
  shipping: { id: 44001 },
};

describe('mapMlOrder', () => {
  it('converte valores, tarifa por unidade, SKU e frete', () => {
    expect(mapMlOrder(base)).toEqual({
      externalId: '2000001',
      status: 'paid',
      orderedAt: '2026-10-10T14:30:00.000-03:00',
      gross: 239.8,
      fee: 31.18,
      units: 2,
      shippingRef: '44001',
      buyerShipping: 0,
      refundPartial: 0,
      listingType: null,
      items: [{ sku: 'KIT-CG160', title: 'Kit Relação CG 160', quantity: 2, unitPrice: 119.9, listingId: 'MLB123' }],
    });
  });
  it('sem SKU do vendedor usa o código do anúncio', () => {
    const o = { ...base, order_items: [{ ...base.order_items[0]!, item: { id: 'MLB9', title: 'X', seller_sku: null } }] };
    expect(mapMlOrder(o)?.items[0]?.sku).toBe('MLB9');
  });
  it('mapeia cancelado e ignora pedidos não pagos', () => {
    expect(mapMlOrder({ ...base, status: 'cancelled' })?.status).toBe('cancelled');
    expect(mapMlOrder({ ...base, status: 'payment_required' })).toBeNull();
  });
});

describe('mapMlItem', () => {
  it('usa a primeira foto em https e mantém status/estoque', () => {
    expect(
      mapMlItem({
        id: 'MLB1',
        title: 'Capacete',
        status: 'paused',
        sub_status: ['out_of_stock'],
        price: 549.9,
        available_quantity: 0,
        permalink: 'https://produto.mercadolivre.com.br/MLB-1',
        thumbnail: 'http://http2.mlstatic.com/D_1-I.jpg',
        pictures: [{ secure_url: 'https://http2.mlstatic.com/D_1-O.jpg' }],
      }),
    ).toEqual({
      externalId: 'MLB1',
      title: 'Capacete',
      pictureUrl: 'https://http2.mlstatic.com/D_1-O.jpg',
      permalink: 'https://produto.mercadolivre.com.br/MLB-1',
      price: 549.9,
      availableQuantity: 0,
      status: 'paused',
      subStatus: ['out_of_stock'],
      soldQuantity: null,
      listingTypeId: null,
      categoryId: null,
      freeShipping: false,
      logisticType: null,
      catalogListing: false,
      picturesCount: 1,
      dimensions: null,
      listedAt: null,
      originalPrice: null,
      feeBonus: null,
      promoName: null,
      sku: null,
      variationSkus: [],
    });
  });
  it('lê o SKU do anúncio e das variações', () => {
    const l = mapMlItem({
      id: 'MLB3',
      title: 'Luva',
      status: 'active',
      attributes: [{ id: 'SELLER_SKU', value_name: 'LUVA-X11' }],
      variations: [
        { attributes: [{ id: 'SELLER_SKU', value_name: 'LUVA-X11-P' }] },
        { seller_custom_field: 'LUVA-X11-M' },
        { attributes: [{ id: 'SELLER_SKU', value_name: 'LUVA-X11-P' }] },
      ],
    });
    expect(l.sku).toBe('LUVA-X11');
    expect(l.variationSkus).toEqual(['LUVA-X11-P', 'LUVA-X11-M']);
  });
});

describe('sellerSku (regra NVS-WMS)', () => {
  it('prefere o SKU humano e ignora códigos gerados pelo ML', () => {
    expect(sellerSku({ id: 'MLB1', seller_sku: 'KIT-1' })).toBe('KIT-1');
    expect(sellerSku({ id: 'MLB1', seller_sku: 'MLB1_123', seller_custom_field: 'KIT-2' })).toBe('KIT-2');
    expect(sellerSku({ id: 'MLB1' })).toBe('MLB1');
  });
  it('sem fotos usa a miniatura convertida para https', () => {
    expect(mapMlItem({ id: 'MLB2', title: 'X', status: 'active', thumbnail: 'http://a/b.jpg' }).pictureUrl).toBe('https://a/b.jpg');
  });
});

describe('preço riscado e bônus de tarifa', () => {
  it('original_price só conta quando maior que o preço atual', () => {
    expect(mapMlItem({ id: 'MLB1', title: 'X', status: 'active', price: 80, original_price: 100 }).originalPrice).toBe(100);
    expect(mapMlItem({ id: 'MLB1', title: 'X', status: 'active', price: 100, original_price: 100 }).originalPrice).toBeNull();
  });
  it('bônus = preço cheio × % bancada pelo ML, só na campanha em andamento', () => {
    expect(feeBonusOf([{ status: 'pending', meli_percentage: 30 }, { status: 'started', meli_percentage: 4.5, name: 'X' }], 129.9)).toEqual({ bonus: 5.85, name: 'X' });
    expect(feeBonusOf([{ status: 'started', meli_percentage: null }], 100)).toBeNull();
  });
});
