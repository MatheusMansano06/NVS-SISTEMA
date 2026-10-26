import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AbcCurveDto } from '@nvs/shared';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';

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

// meia-noite (São Paulo) do primeiro dia do período de 30 dias
const START_30D = `(((now() AT TIME ZONE 'America/Sao_Paulo')::date - 29)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;

describe.skipIf(!TEST_DB)('Curva ABC', () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
    db = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  /**
   * Últimos 30 dias, só vendas pagas: MLB1 R$ 500 (1 un), MLB2 R$ 300 (3 un), MLB3 R$ 150 (2 un), MLB4 R$ 50 (10 un).
   * Faturamento acumulado 50% · 80% · 95% · 100% (bate exatamente nos limites). Fora da conta: um cancelado,
   * um pedido 1 segundo antes do período e o MLB5 (R$ 1.000) de 40 dias atrás, que só entra em 60 dias.
   */
  async function company() {
    const cnpj = randomCnpj();
    const email = `abc-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = res.json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'Loja', $2) RETURNING id`,
        [tenantId, cnpj],
      );
      const a = acc.rows[0].id;
      await c.query(
        `INSERT INTO listings (tenant_id, account_id, marketplace, external_id, title, picture_url, permalink, status)
         VALUES ($1, $2, 'mercado_livre', 'MLB1', 'Garrafa térmica', 'https://img/1.jpg', 'https://ml/MLB1', 'active')`,
        [tenantId, a],
      );
      let n = 0;
      const order = async (status: string, at: string, items: [string, number, number][]) => {
        const gross = items.reduce((s, [, q, p]) => s + q * p, 0);
        const o = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee, shipping_cost, units)
           VALUES ($1, $2, 'mercado_livre', $3, $4, ${at}, $5, 0, 0, 1) RETURNING id`,
          [tenantId, a, `P${++n}`, status, gross],
        );
        for (const [listing, qty, price] of items) {
          await c.query(
            `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, listing_id) VALUES ($1, $2, $3, 'Item ' || $3, $4, $5, $3)`,
            [tenantId, o.rows[0].id, listing, qty, price],
          );
        }
      };
      await order('paid', START_30D, [['MLB1', 1, 500]]); // primeiro instante do período: entra
      await order('paid', `now() - interval '1 day'`, [['MLB2', 2, 100], ['MLB4', 4, 5]]);
      await order('paid', `now() - interval '2 days'`, [['MLB2', 1, 100], ['MLB3', 2, 75], ['MLB4', 6, 5]]);
      await order('cancelled', `now() - interval '1 day'`, [['MLB3', 5, 75]]);
      await order('paid', `${START_30D} - interval '1 second'`, [['MLB4', 50, 5]]);
      await order('paid', `now() - interval '40 days'`, [['MLB5', 1, 1000]]);
    });
    return { cookies, tenantId };
  }

  const get = async (cookies: Record<string, string>, period: string) =>
    (await app.inject({ method: 'GET', url: `/api/v1/sales/abc?period=${period}`, cookies })).json() as AbcCurveDto;
  const classOf = (r: AbcCurveDto, by: 'byRevenue' | 'byUnits') =>
    Object.fromEntries(r.items.map((i) => [i.listingId, i[by].class]));

  it('por faturamento: exatamente 80% ainda é A e exatamente 95% ainda é B', async () => {
    const { cookies } = await company();
    const r = await get(cookies, '30d');
    expect(r.totals).toEqual({ listings: 4, revenue: 1000, units: 16 });
    expect(r.items.map((i) => i.listingId)).toEqual(['MLB1', 'MLB2', 'MLB3', 'MLB4']);
    expect(classOf(r, 'byRevenue')).toEqual({ MLB1: 'A', MLB2: 'A', MLB3: 'B', MLB4: 'C' });
    expect(r.items.map((i) => i.byRevenue.cumulative)).toEqual([0.5, 0.8, 0.95, 1]);
    expect(r.items[0]).toMatchObject({ title: 'Garrafa térmica', pictureUrl: 'https://img/1.jpg', revenue: 500, units: 1 });
    expect(r.items[1]).toMatchObject({ title: 'Item MLB2', pictureUrl: null, revenue: 300, units: 3 });
    expect(r.summary.revenue).toEqual({
      A: { listings: 2, value: 800, share: 0.8 },
      B: { listings: 1, value: 150, share: 0.15 },
      C: { listings: 1, value: 50, share: 0.05 },
    });
  });

  it('por unidades: a fila muda e passar de 80% (81,25%) já é B', async () => {
    const { cookies } = await company();
    const r = await get(cookies, '30d');
    // MLB4 10 un (62,5%) · MLB2 3 (81,25%) · MLB3 2 (93,75%) · MLB1 1 (100%)
    expect(classOf(r, 'byUnits')).toEqual({ MLB4: 'A', MLB2: 'B', MLB3: 'B', MLB1: 'C' });
    const mlb2 = r.items.find((i) => i.listingId === 'MLB2')!;
    expect(mlb2.byUnits).toEqual({ rank: 2, share: 3 / 16, cumulative: 0.813, class: 'B' });
    expect(r.summary.units).toEqual({
      A: { listings: 1, value: 10, share: 10 / 16 },
      B: { listings: 2, value: 5, share: 5 / 16 },
      C: { listings: 1, value: 1, share: 1 / 16 },
    });
  });

  it('60 dias inclui as vendas mais antigas; empate no faturamento desempata pelas unidades', async () => {
    const { cookies } = await company();
    const r = await get(cookies, '60d');
    // faturamento 2.250: MLB5 1000 (44,4%) · MLB1 500 (66,7%) · MLB4 300/60 un (80%) · MLB2 300/3 un (93,3%) · MLB3 150 (100%)
    expect(r.totals).toEqual({ listings: 5, revenue: 2250, units: 67 });
    expect(r.items.map((i) => i.listingId)).toEqual(['MLB5', 'MLB1', 'MLB4', 'MLB2', 'MLB3']);
    expect(classOf(r, 'byRevenue')).toEqual({ MLB5: 'A', MLB1: 'A', MLB4: 'A', MLB2: 'B', MLB3: 'C' });
  });

  it('cada empresa vê só os seus anúncios; sem o recurso Vendas, bloqueia', async () => {
    const a = await company();
    const cnpj = randomCnpj();
    const email = `abc-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const other = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    expect((await get(other, '30d')).totals).toEqual({ listings: 0, revenue: 0, units: 0 });

    await db.query(`UPDATE tenants SET features = array_remove(features, 'vendas') WHERE id = $1`, [a.tenantId]);
    const locked = await app.inject({ method: 'GET', url: '/api/v1/sales/abc?period=30d', cookies: a.cookies });
    expect(locked.statusCode).toBe(403);
    const bad = await app.inject({ method: 'GET', url: '/api/v1/sales/abc?period=7d', cookies: other });
    expect(bad.statusCode).toBe(400);
  });
});
