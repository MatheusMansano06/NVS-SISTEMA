import { describe, expect, it } from 'vitest';
import { mapTiktokProduct } from './tiktok-product.js';

describe('mapTiktokProduct', () => {
  it('usa o menor preço entre as variações e soma o estoque de todas', () => {
    const row = mapTiktokProduct({
      id: '1729',
      title: ' Camiseta ',
      status: 'SELLER_DEACTIVATED',
      skus: [
        { price: { tax_exclusive_price: '59.90' }, inventory: [{ quantity: 2 }, { quantity: 3 }] },
        { price: { sale_price: '49.90', tax_exclusive_price: '55.00' }, inventory: [{ quantity: 0 }] },
      ],
    });
    expect(row).toEqual({ product_id: '1729', title: 'Camiseta', status: 'SELLER_DEACTIVATED', price: 49.9, available_quantity: 5 });
  });

  it('sem variações: estoque zero e preço desconhecido', () => {
    expect(mapTiktokProduct({ id: '1', title: '', status: 'freeze' })).toEqual({
      product_id: '1', title: 'Produto', status: 'FREEZE', price: null, available_quantity: 0,
    });
  });

  it('produto excluído não entra', () => {
    expect(mapTiktokProduct({ id: '1', status: 'DELETED' })).toBeNull();
  });
});
