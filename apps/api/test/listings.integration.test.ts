import { randomBytes, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { SalesIngestion } from '../src/modules/sales/index.js';
import type { MlApi } from '../src/modules/mercado-livre/index.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;

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

// a aba lê só do banco: nenhuma chamada ao ML é esperada nestes cenários
const fail = async (): Promise<never> => {
  throw new Error('não deveria chamar o Mercado Livre');
};
const noMl = new Proxy({} as MlApi, { get: () => fail });

describe.skipIf(!TEST_DB)('Aba Anúncios', () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        ML_CLIENT_ID: 'app-teste',
        ML_CLIENT_SECRET: 'segredo-teste',
        ML_REDIRECT_URI: 'https://exemplo.test/api/v1/integrations/mercado-livre/callback',
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }),
      mlApi: noMl,
    });
    db = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  /** Empresa com 2 anúncios ativos (um com custo e vendas) e 1 pausado. */
  async function company(prefix: string) {
    const cnpj = randomCnpj();
    const email = `anuncios-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = res.json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', $2, $3) RETURNING id`,
        [tenantId, `Loja ${prefix}`, `${prefix}-1`],
      );
      const accountId = acc.rows[0].id;
      const listing = (id: string, sku: string, status: string, price: number, sold: number) =>
        c.query(
          `INSERT INTO listings (tenant_id, account_id, marketplace, external_id, title, status, price, available_quantity,
                                 sku, sold_quantity, listing_type_id, logistic_type, free_shipping, dimensions)
           VALUES ($1, $2, 'mercado_livre', $3, $4, $5, $6, 10, $7, $8, 'gold_special', 'fulfillment', true, '27x20x13,305')`,
          [tenantId, accountId, id, `Viseira ${sku}`, status, price, sku, sold],
        );
      await listing(`MLB${prefix}1`, `${prefix}-A`, 'active', 100, 50);
      await listing(`MLB${prefix}2`, `${prefix}-B`, 'active', 80, 5);
      await listing(`MLB${prefix}3`, `${prefix}-C`, 'paused', 60, 0);
      await c.query(`INSERT INTO sku_costs (tenant_id, sku, custo_unit) VALUES ($1, $2, 30)`, [tenantId, `${prefix}-A`]);
      // venda de 1 item com tarifa 14 e frete 20 (já enriquecida)
      const o = await c.query(
        `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount,
                             marketplace_fee, shipping_cost, units, finance_enriched_at)
         VALUES ($1, $2, 'mercado_livre', $3, 'paid', now() - interval '1 day', 100, 14, 20, 1, now()) RETURNING id`,
        [tenantId, accountId, `${prefix}-pedido-1`],
      );
      await c.query(
        `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, listing_id) VALUES ($1, $2, $3, 'x', 1, 100, $4)`,
        [tenantId, o.rows[0].id, `${prefix}-A`, `MLB${prefix}1`],
      );
      // a sincronização recalcula a média de tarifa/frete por anúncio
      await new SalesIngestion().refreshListingSalesStats(c, accountId);
    });
    return { cookies, tenantId };
  }

  it('lista do banco, com margem estimada pelas vendas e contadores por aba', async () => {
    const { cookies } = await company('11');
    const r = await app.inject({ method: 'GET', url: '/api/v1/listings?status=active', cookies });
    expect(r.statusCode).toBe(200);
    const body = r.json();
    expect(body.counts).toEqual({ active: 2, paused: 1, closed: 0 });
    expect(body.total).toBe(2);
    const [top, other] = body.items;
    expect(top).toMatchObject({
      id: 'MLB111',
      sku: '11-A',
      type: 'Clássico',
      logistic: 'full',
      dimensions: '27 x 20 x 13 cm · 305 g',
      cost: 30,
      margin: { fee: 14, freight: 20, cost: 30, amount: 36, source: 'sales' },
    });
    expect(other.margin.amount).toBeNull(); // sem custo nem vendas: margem desconhecida

    const busca = await app.inject({ method: 'GET', url: '/api/v1/listings?status=paused&q=11-C', cookies });
    expect(busca.json().items.map((i: { id: string }) => i.id)).toEqual(['MLB113']);

    const vendas = await app.inject({ method: 'GET', url: '/api/v1/listings/MLB111/sales', cookies });
    expect(vendas.json().totals).toEqual({ orders: 1, units: 1, gross: 100 });
  });

  it('cada empresa só enxerga os próprios anúncios', async () => {
    const a = await company('21');
    const b = await company('22');
    const ra = (await app.inject({ method: 'GET', url: '/api/v1/listings?status=active', cookies: a.cookies })).json();
    const rb = (await app.inject({ method: 'GET', url: '/api/v1/listings?status=active', cookies: b.cookies })).json();
    expect(ra.items.every((i: { id: string }) => i.id.startsWith('MLB21'))).toBe(true);
    expect(rb.items.every((i: { id: string }) => i.id.startsWith('MLB22'))).toBe(true);
    // vendas e ações no anúncio de outra empresa: invisível
    const sales = await app.inject({ method: 'GET', url: '/api/v1/listings/MLB211/sales', cookies: b.cookies });
    expect(sales.json().total).toBe(0);
    const price = await app.inject({ method: 'PUT', url: '/api/v1/listings/MLB211/price', cookies: b.cookies, payload: { price: 1 } });
    expect(price.statusCode).toBe(404);
  });

  it('alterar sem conta conectada é bloqueado antes de chamar o Mercado Livre', async () => {
    const { cookies } = await company('31');
    const r = await app.inject({ method: 'PUT', url: '/api/v1/listings/MLB312/stock', cookies, payload: { quantity: 3 } });
    expect(r.statusCode).toBe(409);
    expect(r.json().error.code).toBe('LISTING_BLOCKED');
  });

  it('tour da Gertrudez: cada usuário marca o que já viu; outra empresa não enxerga', async () => {
    const a = await company('41');
    const b = await company('42');
    expect((await app.inject({ method: 'GET', url: '/api/v1/tours', cookies: a.cookies })).json()).toEqual({ seen: [] });
    const put = await app.inject({ method: 'PUT', url: '/api/v1/tours/anuncios', cookies: a.cookies, payload: { status: 'skipped' } });
    expect(put.statusCode).toBe(204);
    await app.inject({ method: 'PUT', url: '/api/v1/tours/anuncios', cookies: a.cookies, payload: { status: 'done' } });
    expect((await app.inject({ method: 'GET', url: '/api/v1/tours', cookies: a.cookies })).json()).toEqual({ seen: ['anuncios'] });
    expect((await app.inject({ method: 'GET', url: '/api/v1/tours', cookies: b.cookies })).json()).toEqual({ seen: [] });
    const bad = await app.inject({ method: 'PUT', url: '/api/v1/tours/Nao Vale', cookies: a.cookies, payload: { status: 'done' } });
    expect(bad.statusCode).toBe(400);
  });

  it('radar de frete: alerta quando o frete do ML sobe (≥30% e ≥R$3) e mostra o efeito na margem', async () => {
    const a = await company('51');
    const tenantId = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: a.cookies })).json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const h = (id: string, daysAgo: number, cost: number) =>
        c.query(
          'INSERT INTO listing_freight_history (tenant_id, listing_id, day, list_cost) VALUES ($1, $2, current_date - $3::int, $4)',
          [tenantId, id, daysAgo, cost],
        );
      // MLB511: 10 → 40 (alerta); MLB512: 20 → 21 (variação pequena, sem alerta)
      await h('MLB511', 6, 10);
      await h('MLB511', 2, 40);
      await h('MLB511', 1, 40);
      await h('MLB512', 6, 20);
      await h('MLB512', 1, 21);
    });
    const r = (await app.inject({ method: 'GET', url: '/api/v1/freight-radar', cookies: a.cookies })).json();
    expect(r.monitored).toBe(2);
    expect(r.alerts.map((x: { id: string }) => x.id)).toEqual(['MLB511']);
    expect(r.alerts[0]).toMatchObject({ current: 40, reference: 10, referenceSource: 'history', units30d: 1, monthlyImpact: 30 });
    expect(r.alerts[0].since).toBe(new Date(Date.now() - 2 * 86_400_000).toISOString().slice(0, 10));
    // margem: 100 − tarifa 14 − frete − custo 30 (sem imposto) → antes 46, depois 16
    expect(r.alerts[0]).toMatchObject({ marginBefore: 46, marginAfter: 16 });
    expect(r.alerts[0].history).toHaveLength(3);
    // outra empresa não vê
    const b = await company('52');
    expect((await app.inject({ method: 'GET', url: '/api/v1/freight-radar', cookies: b.cookies })).json().monitored).toBe(0);
  });
});
