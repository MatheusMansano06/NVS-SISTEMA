import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
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

const listing = (title: string, salesPerDay: number, passSales: boolean, passReviews: boolean) => ({
  title, link: `https://www.mercadolivre.com.br/${encodeURIComponent(title)}/up/MLBU1`, salesPerDay, passSales, passReviews,
  ageDays: 60, estSales: Math.round(salesPerDay * 60), reviewDays7d: passReviews ? 5 : 1, reviews7d: passReviews ? 15 : 1,
});

describe.skipIf(!TEST_DB)('Produto Campeão: rotas', () => {
  let app: FastifyInstance;
  const db = new Database(TEST_DB!);
  let cookies: Record<string, string> = {};
  let tenantId = '';
  const api = (method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/product-radar${url}`, cookies, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
    const cnpj = randomCnpj();
    const email = `radar-prod-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    tenantId = res.json().tenant.id;
  });
  afterAll(async () => {
    if (tenantId) await db.query(`DELETE FROM tenants WHERE id = $1`, [tenantId]);
    await app.close();
    await db.pool.end();
  });

  it('bloqueia sem o recurso liberado', async () => {
    const res = await api('GET', '');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_LOCKED');
  });

  it('grava os estudos, recalcula as contagens e monta o ranking do dia', async () => {
    await db.query(`UPDATE tenants SET features = array_append(features, 'radar_produtos') WHERE id = $1`, [tenantId]);
    const day = '2026-10-23';
    const save = (search: string, verdict: string, listings: object[]) =>
      api('POST', '/products', { day, category: 'Carenagem', search, verdict, listings });

    expect((await save('Frente Titan 160', 'arriscado', [listing('A', 14.8, true, true), listing('B', 56, true, false), listing('C', 0.6, false, false)])).statusCode).toBe(201);
    expect((await save('rabeta fan 160', 'viavel', [listing('D', 9, true, true), listing('E', 30, true, true)])).statusCode).toBe(201);
    // mesma busca no mesmo dia substitui (sem duplicar)
    expect((await save('frente titan 160', 'arriscado', [listing('A', 14.8, true, true), listing('B', 56, true, false), listing('F', 3, true, true)])).statusCode).toBe(201);
    expect((await save('banco cg', 'inviavel', [listing('G', 0.2, false, true)], )).statusCode).toBe(201);

    const res = await api('GET', '');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.day).toBe(day);
    expect(body.days).toEqual([{ day, products: 3, viable: 1 }]);
    expect(body.products.map((p: { search: string }) => p.search)).toEqual(['rabeta fan 160', 'frente titan 160', 'banco cg']);
    expect(body.products[1]).toMatchObject({ analyzed: 3, passSales: 3, passReviews: 2, approved: 2, leaderSalesPerDay: 14.8 });
    expect(body.products[1].listings.map((l: { approved: boolean }) => l.approved)).toEqual([true, false, true]);
  });

  it('valida o corpo e apaga um estudo', async () => {
    expect((await api('POST', '/products', { search: 'x', verdict: 'otimo', listings: [] })).statusCode).toBe(400);
    const { products } = (await api('GET', '?day=2026-10-23')).json();
    expect((await api('DELETE', `/products/${products[2].id}`)).statusCode).toBe(204);
    expect((await api('DELETE', `/products/${products[2].id}`)).statusCode).toBe(404);
    expect((await api('GET', '')).json().products).toHaveLength(2);
  });
});
