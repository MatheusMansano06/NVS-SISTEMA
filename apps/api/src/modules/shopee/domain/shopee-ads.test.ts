import { describe, expect, it } from 'vitest';
import { mapAdsDay, mapShopeeItem } from './shopee-ads.js';
import { orderFinance } from './shopee-escrow.js';

describe('Shopee Ads e anúncios fora do ar', () => {
  it('converte o dia do Ads (DD-MM-AAAA) e ignora data ilegível', () => {
    expect(mapAdsDay({ date: '11-11-2026', expense: '123.456', broad_gmv: 900.1, clicks: '40', impression: 1000 })).toEqual({
      day: '2026-11-11', expense: 123.46, gmv: 900.1, clicks: 40, impressions: 1000,
    });
    expect(mapAdsDay({ date: '2026/11/11', expense: 1 })).toBeNull();
  });

  it('anúncio fora do ar: preço, estoque e foto', () => {
    expect(mapShopeeItem({ item_id: 7, item_name: ' Protetor ', price_info: [{ current_price: 63.54 }], stock_info_v2: { summary_info: { total_available_stock: 0 } }, image: { image_url_list: ['u'] } }, 'UNLIST'))
      .toEqual({ item_id: '7', title: 'Protetor', status: 'UNLIST', picture_url: 'u', price: 63.54, available_quantity: 0 });
    expect(mapShopeeItem({ item_id: 8, item_status: 'banned' }, 'UNLIST')).toMatchObject({ title: 'Produto', status: 'BANNED', price: null, available_quantity: null });
  });

  it('a recarga de Ads tirada do repasse não é tarifa do pedido', () => {
    const base = { produto: 100, cupom: 0, tarifa: 22, tarifa_refund: 0, frete_comprador: 0, frete_vendedor: 0, ajuste: 0, returned: false, escrow_after_adjustment: 78 };
    expect(orderFinance(base, 100).fee).toBe(22);
    expect(orderFinance({ ...base, ads_fee: 2.4 }, 100).fee).toBe(19.6);
  });
});
