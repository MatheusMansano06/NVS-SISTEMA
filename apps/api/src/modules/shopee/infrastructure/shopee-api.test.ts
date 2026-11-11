import { describe, expect, it } from 'vitest';
import { HttpShopeeApi, signShopee } from './shopee-api.js';

describe('link de autorização da Shopee', () => {
  it('usa o auth_partner assinado e leva o state no caminho do retorno', () => {
    const api = new HttpShopeeApi({ partnerId: '2001887', partnerKey: 'k', redirectUri: 'https://nvs.test/api/v1/integrations/shopee/callback' });
    const url = new URL(api.authorizationUrl('abc_123'));
    expect(url.origin + url.pathname).toBe('https://partner.shopeemobile.com/api/v2/shop/auth_partner');
    expect(url.searchParams.get('redirect')).toBe('https://nvs.test/api/v1/integrations/shopee/callback/abc_123');
    const ts = url.searchParams.get('timestamp')!;
    expect(url.searchParams.get('sign')).toBe(signShopee('k', `2001887/api/v2/shop/auth_partner${ts}`));
  });
});
