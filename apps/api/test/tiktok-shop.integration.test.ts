import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { todayIn } from '../src/modules/sales/domain/period.js';
import type { TiktokApi } from '../src/modules/tiktok-shop/index.js';
import type { TiktokFinanceTx } from '../src/modules/tiktok-shop/domain/tiktok-order.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;

function randomCnpj(): string {
  const b = Array.from({ length: 12 }, () => randomInt(0, 10));
  const dv = (n: number[]) => {
    const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = n.reduce((a, x, i) => a + x * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  b.push(dv(b));
  b.push(dv(b));
  const c = b.join('');
  return /^(\d)\1+$/.test(c) ? randomCnpj() : c;
}

describe.skipIf(!TEST_DB)('TikTok Shop: conexão, histórico e Análise Financeira', () => {
  let app: FastifyInstance;
  let db: Database;
  const shopId = `S${randomInt(1e9)}`;
  const soldAt = Date.now() - 5 * DAY;
  const tokens = { accessToken: 'at', refreshToken: 'rt', accessExpiresAt: new Date(Date.now() + 7 * DAY), refreshExpiresAt: null, sellerName: 'Novaes' };
  const sold = Math.floor(soldAt / 1000);
  const caneca = { sku_id: 's1', seller_sku: 'TT-CANECA', product_id: 'p1', product_name: 'Caneca', sku_image: 'https://img/caneca.jpg', original_price: '45.00', seller_discount: '5.00' };
  const garrafa = { sku_id: 's2', seller_sku: 'TT-GARRAFA', product_id: 'p2', product_name: 'Garrafa', original_price: '80.00', sale_price: '80.00' };
  const id = (n: string) => `${shopId}-${n}`;
  /**
   * A: entregue e repassada — 2 canecas (45 de tabela, 5 de desconto seu, 5 bancados pelo TikTok) + 1 garrafa
   * B: em trânsito, ainda sem repasse (o TikTok manda a estimativa)
   * C: caneca devolvida, com reembolso do TikTok de 15
   * D: cancelada · E: não paga (ignorada)
   */
  const orders = [
    { id: id('A'), status: 'DELIVERED', create_time: sold, shipping_type: 'TIKTOK', line_items: [{ ...caneca, sale_price: '35.00', platform_discount: '5.00' }, { ...caneca, sale_price: '35.00', platform_discount: '5.00' }, garrafa] },
    { id: id('B'), status: 'IN_TRANSIT', create_time: sold, shipping_type: 'TIKTOK', line_items: [garrafa] },
    { id: id('C'), status: 'COMPLETED', create_time: sold, shipping_type: 'TIKTOK', line_items: [{ ...caneca, sale_price: '40.00' }] },
    { id: id('D'), status: 'CANCELLED', create_time: sold, line_items: [garrafa] },
    { id: id('E'), status: 'UNPAID', create_time: sold, line_items: [garrafa] },
  ];
  const statements: Record<string, TiktokFinanceTx[]> = {
    S1: [
      { type: 'ORDER', id: id('t1'), order_id: id('A'), revenue_amount: '160', fee_tax_amount: '-30', shipping_cost_amount: '-12', settlement_amount: '118',
        revenue_breakdown: { subtotal_before_discount_amount: '170', seller_discount_amount: '-10' },
        fee_tax_breakdown: { fee: { platform_commission_amount: '-16', sfp_service_fee_amount: '-2', fee_per_item_sold_amount: '-12' } } },
      { type: 'ORDER', id: id('t2'), order_id: id('C'), fee_tax_amount: '-2', settlement_amount: '-2',
        revenue_breakdown: { subtotal_before_discount_amount: '45', seller_discount_amount: '-5', refund_subtotal_before_discount_amount: '-45', seller_discount_refund_amount: '5' } },
      { type: 'PLATFORM_REIMBURSEMENT', id: id('t3'), adjustment_order_id: id('C'), adjustment_amount: '15', settlement_amount: '15' },
    ],
    S2: [{ type: 'GMV_PAYMENT_FOR_TIKTOK_ADS', id: id('t4'), adjustment_amount: '-39', settlement_amount: '-39' }],
  };
  const api: TiktokApi = {
    authorizationUrl: (state) => `https://tiktok.test/authorize?state=${state}`,
    exchangeCode: async () => tokens,
    refresh: async () => tokens,
    shops: async () => [{ id: shopId, name: 'Loja TikTok', region: 'BR', cipher: 'cipher-1' }],
    // histórico: só a janela que contém a venda; de hora em hora (update): os mesmos pedidos de novo
    searchOrders: async (_t, _c, from, to, by) => ({
      orders: by === 'update' || (from.getTime() <= soldAt && soldAt < to.getTime()) ? orders : [],
      next: null,
    }),
    statements: async () => ({ statements: [{ id: 'S1', statement_time: sold + 86_400 }, { id: 'S2', statement_time: Math.floor(Date.now() / 1000) - 3600 }], next: null }),
    statementTransactions: async (_t, _c, statementId) => ({ transactions: statements[statementId] ?? [], next: null }),
    unsettled: async () => ({
      transactions: [{ type: 'ORDER', id: id('u1'), order_id: id('B'), est_revenue_amount: '80', est_fee_tax_amount: '-14.8', est_shipping_cost_amount: '-3', est_settlement_amount: '62.2' }],
      next: null,
    }),
  };

  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        TIKTOK_SHOP_APP_KEY: 'k',
        TIKTOK_SHOP_APP_SECRET: 's',
        TIKTOK_SHOP_SERVICE_ID: '1',
        TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      }),
      tiktokApi: api,
    });
    db = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('só conecta com o recurso liberado; traz o histórico e mostra os números só na aba TikTok Shop', async () => {
    const cnpj = randomCnpj();
    const email = `tt-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = login.json().tenant.id as string;
    const base = '/api/v1/integrations/tiktok-shop';
    const get = (url: string) => app.inject({ method: 'GET', url, cookies });

    // empresa sem o recurso: nada aparece e não dá para conectar
    expect((await get(`${base}/status`)).json()).toEqual({ configured: false, connections: [] });
    expect((await get(`${base}/connect`)).statusCode).toBe(403);

    await db.query(`UPDATE tenants SET features = array_append(features, 'tiktok_shop') WHERE id = $1`, [tenantId]);
    const state = new URL((await get(`${base}/connect`)).json().url).searchParams.get('state')!;

    // state desconhecido (ex.: autorização aberta fora do sistema) é recusado
    expect((await app.inject({ method: 'GET', url: `${base}/callback?code=x&state=nope` })).headers.location).toBe('/integracoes?tiktok=error&reason=state');
    expect((await app.inject({ method: 'GET', url: `${base}/callback?code=x&state=${state}` })).headers.location).toBe('/integracoes?tiktok=connected');
    await app.tiktok!.idle();

    const status = (await get(`${base}/status`)).json();
    expect(status.connections).toHaveLength(1);
    expect(status.connections[0]).toMatchObject({ nickname: 'Loja TikTok', shopId, status: 'active', syncing: false, syncError: null, ordersImported: 4, historyDone: true });

    const rows = async () =>
      Object.fromEntries(
        (
          await db.withTenant(tenantId, (c) =>
            c.query(
              `SELECT right(external_id, 1) AS k, gross_amount::float AS gross, coupon_seller::float AS coupon, marketplace_fee::float AS fee,
                      shipping_cost::float AS shipping, refund_partial::float AS refund, finance_enriched_at IS NOT NULL AS settled
                 FROM orders WHERE marketplace = 'tiktok_shop' ORDER BY external_id`,
            ),
          )
        ).rows.map(({ k, ...r }) => [k, r]),
      );
    const expected = {
      // extrato: tarifas 30 e frete 12; faturado pelo preço de tabela, com o desconto do vendedor à parte
      A: { gross: 170, coupon: 10, fee: 30, shipping: 12, refund: 0, settled: true },
      // sem repasse: estimativa do TikTok no lugar da conta provisória (80 × 6% + 6 = 10,80)
      B: { gross: 80, coupon: 0, fee: 14.8, shipping: 3, refund: 0, settled: false },
      // devolução de 40 (45 − 5 de desconto), abatida do reembolso de 15 do TikTok; a tarifa que sobrou fica
      C: { gross: 45, coupon: 5, fee: 2, shipping: 0, refund: 25, settled: true },
      D: { gross: 80, coupon: 0, fee: 0, shipping: 0, refund: 0, settled: true },
    };
    expect(await rows()).toEqual(expected);

    const today = todayIn();
    const from = new Date(Date.parse(today) - 10 * DAY).toISOString().slice(0, 10);
    const range = `from=${from}&to=${today}&fresh=true`;
    const summary = async (extra = '') => (await get(`/api/v1/finance/summary?${range}${extra}`)).json();

    const tt = await summary('&marketplace=tiktok_shop');
    expect(tt.cards).toMatchObject({ qtdCanceladas: 1, tarifa: 46.8, freteVendedor: 15, cupomSeller: 15 });
    // só o pedido B continua em estimativa; anúncio descontado das vendas no extrato
    expect(tt.enriquecimentoPendente).toBe(1);
    expect(tt.adSpend).toBe(39);
    // foto vinda do pedido e tipo de envio no lugar do tipo de anúncio
    const lines = (await get(`/api/v1/finance/lines?${range}&marketplace=tiktok_shop&offset=0&limit=50`)).json().items as { sku: string; pictureUrl: string | null; listingType: string | null }[];
    expect(lines.find((l) => l.sku === 'TT-CANECA')).toMatchObject({ pictureUrl: 'https://img/caneca.jpg', listingType: 'tiktok_tiktok' });

    // sem filtro (Mercado Livre): os pedidos e os anúncios do TikTok não entram
    const ml = await summary();
    expect(ml.cards).toMatchObject({ vendasAprovadas: 0, qtdAprovadas: 0 });
    expect(ml.adSpend).toBe(0);
    const dash = await get('/api/v1/dashboard/summary?period=30d');
    expect(dash.statusCode).toBe(200);
    expect(JSON.stringify(dash.json())).not.toContain('Loja TikTok');

    // atualização seguinte reimporta os pedidos e relê os extratos: nada dobra e nada volta para o provisório
    expect((await app.inject({ method: 'POST', url: `${base}/sync`, cookies, payload: {} })).statusCode).toBe(202);
    await app.tiktok!.idle();
    expect(await rows()).toEqual(expected);
    expect((await summary('&marketplace=tiktok_shop')).adSpend).toBe(39);
  });
});
