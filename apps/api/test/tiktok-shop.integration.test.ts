import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { todayIn } from '../src/modules/sales/domain/period.js';
import type { TiktokApi } from '../src/modules/tiktok-shop/index.js';

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
  const orders = [
    {
      id: `${shopId}-1`,
      status: 'DELIVERED',
      create_time: Math.floor(soldAt / 1000),
      line_items: [
        { sku_id: 's1', seller_sku: 'TT-CANECA', product_id: 'p1', product_name: 'Caneca', sale_price: '35.00', platform_discount: '5.00' },
        { sku_id: 's1', seller_sku: 'TT-CANECA', product_id: 'p1', product_name: 'Caneca', sale_price: '35.00', platform_discount: '5.00' },
        { sku_id: 's2', seller_sku: 'TT-GARRAFA', product_id: 'p2', product_name: 'Garrafa', sale_price: '80.00' },
      ],
    },
    { id: `${shopId}-2`, status: 'CANCELLED', create_time: Math.floor(soldAt / 1000), line_items: [{ sku_id: 's2', seller_sku: 'TT-GARRAFA', sale_price: '80.00' }] },
    { id: `${shopId}-3`, status: 'UNPAID', create_time: Math.floor(soldAt / 1000), line_items: [{ sku_id: 's2', seller_sku: 'TT-GARRAFA', sale_price: '80.00' }] },
  ];
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
    orderTransactions: async (_t, _c, id) =>
      id === `${shopId}-1` ? { statement_transactions: [{ fee_and_tax_amount: '-30.00', shipping_cost_amount: '-12.00' }] } : { statement_transactions: [] },
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
    expect(status.connections[0]).toMatchObject({ nickname: 'Loja TikTok', shopId, status: 'active', syncing: false, syncError: null, ordersImported: 2, historyDone: true });

    const today = todayIn();
    const from = new Date(Date.parse(today) - 10 * DAY).toISOString().slice(0, 10);
    const summary = async (extra = '') => (await get(`/api/v1/finance/summary?from=${from}&to=${today}&fresh=true${extra}`)).json();

    // aba TikTok Shop: 2×40 + 80 de receita (desconto do TikTok volta para o vendedor); tarifa e frete do extrato
    const tt = await summary('&marketplace=tiktok_shop');
    expect(tt.cards).toMatchObject({ vendasAprovadas: 160, qtdAprovadas: 1, qtdCanceladas: 1, tarifa: 30, freteVendedor: 12 });
    expect(tt.enriquecimentoPendente).toBe(0);
    // sem filtro (Mercado Livre): os pedidos do TikTok não entram
    expect((await summary()).cards).toMatchObject({ vendasAprovadas: 0, qtdAprovadas: 0 });
    const dash = await get('/api/v1/dashboard/summary?period=30d');
    expect(dash.statusCode).toBe(200);
    expect(JSON.stringify(dash.json())).not.toContain('Loja TikTok');

    // atualização seguinte reimporta o pedido: a tarifa conferida no extrato não volta para a estimativa
    expect((await app.inject({ method: 'POST', url: `${base}/sync`, cookies, payload: {} })).statusCode).toBe(202);
    await app.tiktok!.idle();
    expect((await summary('&marketplace=tiktok_shop')).cards).toMatchObject({ vendasAprovadas: 160, tarifa: 30, freteVendedor: 12 });
  });
});
