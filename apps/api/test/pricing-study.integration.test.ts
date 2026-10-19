import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';

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

const study = {
  title: 'Exemplo 1',
  link: 'https://www.mercadolivre.com.br/p/MLB22970239',
  supplier: 'Loja',
  notes: null,
  feePct: 11.5,
  taxPct: 4,
  packaging: 0.5,
  cost: 48,
  price: 75.66,
  height: null,
  width: null,
  length: null,
  weightKg: 0.5,
  targetPct: 15,
  categoryId: 'MLB1714',
  categoryName: 'Informática › Mouses',
  feeClassic: 11.5,
  feePremium: 16.5,
  listingType: 'gold_special',
};

describe.skipIf(!TEST_DB)('Precificador › Viabilidade (pesquisas)', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
  });
  afterAll(async () => {
    await app.close();
  });

  async function login() {
    const cnpj = randomCnpj();
    const email = `study-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
  }

  it('cria, edita, lista e exclui — com a margem calculada no servidor e isolada por empresa', async () => {
    const cookies = await login();
    const created = await app.inject({ method: 'POST', url: '/api/v1/pricing/studies', cookies, payload: study });
    expect(created.statusCode).toBe(200);
    const s = created.json();
    expect(s.margin).toBe(7.48);
    expect(s).toMatchObject({ categoryName: 'Informática › Mouses', feePremium: 16.5, listingType: 'gold_special' });

    const updated = await app.inject({ method: 'PUT', url: `/api/v1/pricing/studies/${s.id}`, cookies, payload: { ...study, price: 100, weightKg: 1 } });
    expect(updated.json().margin).toBe(19.55); // R$ 100 já cai na faixa 100–119,99: frete 16,45;

    const list = await app.inject({ method: 'GET', url: '/api/v1/pricing/studies', cookies });
    expect(list.json()).toHaveLength(1);

    const other = await login();
    expect((await app.inject({ method: 'GET', url: '/api/v1/pricing/studies', cookies: other })).json()).toHaveLength(0);
    expect((await app.inject({ method: 'DELETE', url: `/api/v1/pricing/studies/${s.id}`, cookies: other })).statusCode).toBe(404);

    expect((await app.inject({ method: 'DELETE', url: `/api/v1/pricing/studies/${s.id}`, cookies })).statusCode).toBe(204);
  });

  it('recusa pesquisa sem nome', async () => {
    const cookies = await login();
    const res = await app.inject({ method: 'POST', url: '/api/v1/pricing/studies', cookies, payload: { ...study, title: ' ' } });
    expect(res.statusCode).toBe(400);
  });
});
