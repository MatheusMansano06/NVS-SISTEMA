import { randomInt } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { todayIn } from '../src/modules/sales/domain/period.js';
import type { ShopeeApi } from '../src/modules/shopee/index.js';
import { mapShopeeEscrow, orderFinance, type ShopeeEscrowDetail } from '../src/modules/shopee/domain/shopee-escrow.js';
import type { ShopeeOrder } from '../src/modules/shopee/domain/shopee-order.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;
const DAY = 86_400_000;
const fixtures = resolve(import.meta.dirname, '../src/modules/shopee/domain/fixtures');

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

describe.skipIf(!TEST_DB)('Shopee: conexão, histórico, escrow e Análise Financeira', () => {
  let app: FastifyInstance;
  let db: Database;
  const shopId = String(randomInt(1e9));
  const sold = Math.floor((Date.now() - 5 * DAY) / 1000);
  const sn = (k: string) => `${shopId}${k}`;
  // escrows reais (NVS W2) com o número do pedido trocado
  const real: ShopeeEscrowDetail[] = readFileSync(resolve(fixtures, 'escrow-real.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const esc = (from: string, k: string): ShopeeEscrowDetail => ({ ...structuredClone(real.find((e) => e.order_sn === from)!), order_sn: sn(k) });
  const devolucao: ShopeeEscrowDetail = { ...JSON.parse(readFileSync(resolve(fixtures, 'escrow-devolucao.json'), 'utf8')), order_sn: sn('C') };
  const escrows: Record<string, ShopeeEscrowDetail> = { [sn('A')]: esc('SHP-FIX-001', 'A'), [sn('B')]: esc('SHP-FIX-004', 'B'), [sn('C')]: devolucao };

  const item = (sku: string, price: number, qty = 1) => ({
    item_id: 100, item_name: 'Protetor', item_sku: sku, model_id: 0, model_sku: '', model_quantity_purchased: qty,
    model_original_price: price * 2, model_discounted_price: price, image_info: { image_url: 'https://cf.shopee.com.br/file/x' },
  });
  /**
   * A: repasse liberado · B: enviado, ainda sem repasse (escrow estimado) · C: devolvido com reembolso
   * D: cancelado depois de pago · E: não pago · F: cancelado antes de pagar (nenhum dos dois é venda)
   */
  const orders: ShopeeOrder[] = [
    { order_sn: sn('A'), order_status: 'COMPLETED', create_time: sold, pay_time: sold, total_amount: 60.48, fulfillment_flag: 'fulfilled_by_local_seller', item_list: [item('PROESCTW', 63.54)] },
    { order_sn: sn('B'), order_status: 'SHIPPED', create_time: sold, pay_time: sold, total_amount: 96.01, fulfillment_flag: 'fulfilled_by_shopee', item_list: [item('PROCRO160', 79.99), item('OUTRO', 17)] },
    { order_sn: sn('C'), order_status: 'COMPLETED', create_time: sold, pay_time: sold, total_amount: 36.91, item_list: [item('PROCRO160', 79.99)] },
    { order_sn: sn('D'), order_status: 'CANCELLED', create_time: sold, pay_time: sold, total_amount: 50, item_list: [item('OUTRO', 50)] },
    { order_sn: sn('E'), order_status: 'UNPAID', create_time: sold, item_list: [item('OUTRO', 50)] },
    { order_sn: sn('F'), order_status: 'CANCELLED', create_time: sold, item_list: [item('OUTRO', 50)] },
  ];
  const calls = { refresh: 0 };
  const tokens = { accessToken: 'at', refreshToken: 'rt', accessExpiresAt: new Date(Date.now() + 4 * 3600_000), shopIds: [shopId] };
  const api: ShopeeApi = {
    authorizationUrl: (state) => `https://shopee.test/auth?state=${state}`,
    exchangeCode: async () => tokens,
    refresh: async () => {
      calls.refresh++;
      return tokens;
    },
    shopInfo: async () => ({ name: 'Loja Shopee', region: 'BR', authExpiresAt: new Date(Date.now() + 300 * DAY) }),
    // histórico: só a janela que contém a venda; de hora em hora (update_time): os mesmos pedidos de novo
    orderList: async (_t, _s, from, to, field) => ({
      orderSns: field === 'update_time' || (from.getTime() <= sold * 1000 && sold * 1000 <= to.getTime()) ? orders.map((o) => o.order_sn) : [],
      next: null,
    }),
    orderDetails: async (_t, _s, sns) => orders.filter((o) => sns.includes(o.order_sn)),
    escrowDetails: async (_t, _s, sns) => sns.flatMap((s) => (escrows[s] ? [structuredClone(escrows[s])] : [])),
    escrowList: async (_t, _s, from, to) => ({
      released: from.getTime() <= Date.now() - 2 * DAY && Date.now() - 2 * DAY <= to.getTime() ? [{ orderSn: sn('A'), payout: 53.91, releasedAt: new Date(Date.now() - 2 * DAY) }] : [],
      more: false,
    }),
  };

  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        SHOPEE_PARTNER_ID: '1',
        SHOPEE_PARTNER_KEY: 'k',
        SHOPEE_REDIRECT_URI: 'https://nvs.test/api/v1/integrations/shopee/callback',
        TOKEN_ENCRYPTION_KEY: 'ab'.repeat(32),
      }),
      shopeeApi: api,
    });
    db = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('só conecta com o recurso liberado; traz o histórico com o escrow e mostra os números só na aba Shopee', async () => {
    const cnpj = randomCnpj();
    const email = `sh-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = login.json().tenant.id as string;
    const base = '/api/v1/integrations/shopee';
    const get = (url: string) => app.inject({ method: 'GET', url, cookies });

    // empresa sem o recurso: nada aparece e não dá para conectar
    expect((await get(`${base}/status`)).json()).toEqual({ configured: false, connections: [] });
    expect((await get(`${base}/connect`)).statusCode).toBe(403);

    await db.query(`UPDATE tenants SET features = array_append(features, 'shopee') WHERE id = $1`, [tenantId]);
    const state = new URL((await get(`${base}/connect`)).json().url).searchParams.get('state')!;

    expect((await app.inject({ method: 'GET', url: `${base}/callback?code=x&state=nope&shop_id=${shopId}` })).headers.location).toBe('/integracoes?shopee=error&reason=state');
    expect((await app.inject({ method: 'GET', url: `${base}/callback?code=x&state=${state}&shop_id=${shopId}` })).headers.location).toBe('/integracoes?shopee=connected');
    await app.shopee!.idle();

    const status = (await get(`${base}/status`)).json();
    expect(status.connections).toHaveLength(1);
    expect(status.connections[0]).toMatchObject({ nickname: 'Loja Shopee', shopId, status: 'active', syncing: false, syncError: null, ordersImported: 4, historyDone: true });
    expect(status.connections[0].authExpiresAt).toBeTruthy();

    const rows = async () =>
      Object.fromEntries(
        (
          await db.withTenant(tenantId, (c) =>
            c.query(
              `SELECT right(external_id, 1) AS k, status, gross_amount::float AS gross, coupon_seller::float AS coupon, marketplace_fee::float AS fee,
                      shipping_cost::float AS shipping, buyer_shipping::float AS fc, refund_partial::float AS refund,
                      finance_enriched_at IS NOT NULL AS settled
                 FROM orders WHERE marketplace = 'shopee' ORDER BY external_id`,
            ),
          )
        ).rows.map(({ k, ...r }) => [k, r]),
      );
    const fin = (k: string, itemsGross: number) => {
      const f = orderFinance(mapShopeeEscrow(escrows[sn(k)]!), itemsGross);
      return { status: f.status, gross: f.gross, coupon: f.coupon, fee: f.fee, shipping: f.shipping, fc: f.buyerShipping, refund: f.refund };
    };
    const expected = {
      A: { ...fin('A', 63.54), settled: true },
      B: { ...fin('B', 96.99), settled: false },
      C: { ...fin('C', 79.99), settled: false },
      D: { status: 'cancelled', gross: 50, coupon: 0, fee: 0, shipping: 0, fc: 0, refund: 0, settled: true },
    };
    expect(await rows()).toEqual(expected);
    // a margem (sem custo) fecha com o repasse: A 53,91
    expect(expected.A.gross + expected.A.fc - expected.A.coupon - expected.A.fee - expected.A.shipping).toBeCloseTo(53.91, 2);
    expect(expected.C).toMatchObject({ status: 'returned', refund: 79.99 });

    const today = todayIn();
    const from = new Date(Date.parse(today) - 10 * DAY).toISOString().slice(0, 10);
    const range = `from=${from}&to=${today}&fresh=true`;
    const summary = async (extra = '') => (await get(`/api/v1/finance/summary?${range}${extra}`)).json();

    const sh = await summary('&marketplace=shopee');
    expect(sh.cards).toMatchObject({ qtdAprovadas: 2, qtdCanceladas: 1, qtdDevolucoes: 1 });
    // B e C ainda sem repasse liberado
    expect(sh.enriquecimentoPendente).toBe(2);
    const lines = (await get(`/api/v1/finance/lines?${range}&marketplace=shopee&offset=0&limit=50`)).json().items as { sku: string; pictureUrl: string | null; listingType: string | null }[];
    expect(lines.find((l) => l.sku === 'PROESCTW')).toMatchObject({ pictureUrl: 'https://cf.shopee.com.br/file/x', listingType: 'shopee_seller' });

    // sem filtro (Mercado Livre): os pedidos da Shopee não entram
    expect((await summary()).cards).toMatchObject({ vendasAprovadas: 0, qtdAprovadas: 0 });
    const dash = (await get('/api/v1/dashboard/summary?period=30d&fresh=true')).json();
    expect(dash.kpis).toMatchObject({ orders: 0 });

    // atualização seguinte reimporta e relê o escrow: nada dobra e nada volta para o valor do pedido
    expect((await app.inject({ method: 'POST', url: `${base}/sync`, cookies, payload: {} })).statusCode).toBe(202);
    await app.shopee!.idle();
    expect(await rows()).toEqual(expected);
  });
});
