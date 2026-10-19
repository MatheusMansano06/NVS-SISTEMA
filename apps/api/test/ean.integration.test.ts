import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

describe.skipIf(!TEST_DB)('Cadastro de SKUs › Códigos EAN internos', () => {
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

  async function login() {
    const cnpj = randomCnpj();
    const email = `ean-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { cookies: { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value }, tenantId: res.json().tenant.id as string };
  }

  it('gera em sequência (20…), não repete SKU, nunca reaproveita número e liga no Master Data', async () => {
    const { cookies, tenantId } = await login();
    await db.withTenant(tenantId, (c) => c.query(`INSERT INTO wms_products (tenant_id, sku, description) VALUES ($1, 'MOUSE-1', 'Mouse')`, [tenantId]));

    const gen = (items: { sku: string | null; description?: string | null }[]) =>
      app.inject({ method: 'POST', url: '/api/v1/skus/eans', cookies, payload: { items } });

    const r1 = (await gen([{ sku: 'mouse-1', description: 'Mouse gamer' }, { sku: 'PAD-2' }, { sku: 'PAD-2' }])).json();
    expect(r1.created.map((e: { code: string }) => e.code)).toEqual(['2000000000015', '2000000000022']);
    expect(r1.created[0]).toMatchObject({ sku: 'MOUSE-1', inMasterData: true });
    expect(r1.created[1].inMasterData).toBe(false);

    const r2 = (await gen([{ sku: 'PAD-2' }])).json();
    expect(r2.created).toHaveLength(0);
    expect(r2.existing[0].code).toBe('2000000000022');

    expect((await app.inject({ method: 'DELETE', url: '/api/v1/skus/eans/2000000000022', cookies })).statusCode).toBe(204);
    const r3 = (await gen([{ sku: 'CABO-3' }])).json();
    expect(r3.created[0].code).toBe('2000000000039');

    const bad = await app.inject({ method: 'PATCH', url: '/api/v1/skus/eans/2000000000015', cookies, payload: { gtin: '2000000000039' } });
    expect(bad.statusCode).toBe(400);
    const ok = await app.inject({ method: 'PATCH', url: '/api/v1/skus/eans/2000000000015', cookies, payload: { gtin: '4006381333931' } });
    expect(ok.json().gtin).toBe('4006381333931');
    const codes = await db.withTenant(tenantId, async (c) => (await c.query(`SELECT barcode FROM wms_barcodes WHERE sku = 'MOUSE-1' ORDER BY barcode`)).rows.map((r) => r.barcode));
    expect(codes).toEqual(['2000000000015', '4006381333931']);

    // código livre (sem SKU) e associação depois; SKU que já tem código é recusado
    const free = (await gen([{ sku: null }])).json().created[0];
    expect(free).toMatchObject({ code: '2000000000046', sku: null });
    const dup = await app.inject({ method: 'PATCH', url: `/api/v1/skus/eans/${free.code}`, cookies, payload: { sku: 'mouse-1' } });
    expect(dup.statusCode).toBe(400);
    const assoc = await app.inject({ method: 'PATCH', url: `/api/v1/skus/eans/${free.code}`, cookies, payload: { sku: 'fone-4', description: 'Fone' } });
    expect(assoc.json()).toMatchObject({ sku: 'FONE-4', description: 'Fone' });

    const page = (await app.inject({ method: 'GET', url: '/api/v1/skus/eans?limit=2&offset=0', cookies })).json();
    expect(page.total).toBe(3);
    expect(page.items).toHaveLength(2);
    expect(page.free).toBe(0);

    const pdf = await app.inject({ method: 'GET', url: '/api/v1/skus/eans/labels.pdf?codes=2000000000015,2000000000039&qty=2&format=a4', cookies });
    expect(pdf.statusCode).toBe(200);
    expect(pdf.headers['content-type']).toContain('application/pdf');
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');

    // outra empresa começa a própria sequência e não enxerga estes códigos
    const other = await login();
    expect((await app.inject({ method: 'GET', url: '/api/v1/skus/eans', cookies: other.cookies })).json().total).toBe(0);
  });
});
