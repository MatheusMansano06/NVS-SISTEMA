import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { isValidCnpj } from '@nvs/shared';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* .env opcional: em CI as variáveis vêm do ambiente */
}

/** Gera CNPJ válido aleatório (dígitos verificadores corretos). */
function randomCnpj(): string {
  const base = Array.from({ length: 12 }, () => randomInt(0, 10));
  const dv = (nums: number[]) => {
    const w = nums.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = nums.reduce((a, n, i) => a + n * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  base.push(dv(base));
  base.push(dv(base));
  const cnpj = base.join('');
  return /^(\d)\1+$/.test(cnpj) ? randomCnpj() : cnpj;
}

const cookieOf = (res: { cookies: { name: string; value: string }[] }) =>
  res.cookies.find((c) => c.name === 'nvs_session');

// Roda num banco exclusivo (TEST_DATABASE_URL) para nunca sujar o banco de desenvolvimento.
// Requer as migrations aplicadas nele: npm run db:migrate:test
const TEST_DB = process.env.TEST_DATABASE_URL;

describe.skipIf(!TEST_DB)('API (integração)', () => {
  let app: FastifyInstance;

  const register = (email: string, cnpj: string, phone = '11912345678') =>
    app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone, cnpj } });
  const login = (email: string, password: string, remember = false) =>
    app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password, remember } });

  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }),
    });
  });
  afterAll(() => app.close());

  it('gera CNPJ de teste válido', () => {
    expect(isValidCnpj(randomCnpj())).toBe(true);
  });

  it('responde health e ready', async () => {
    expect((await app.inject('/health')).statusCode).toBe(200);
    expect((await app.inject('/ready')).statusCode).toBe(200);
  });

  it('cadastro → login com CNPJ → troca de senha', async () => {
    const cnpj = randomCnpj();
    const email = `dono-${cnpj}@teste.dev`;
    expect((await register(email, cnpj)).statusCode).toBe(201);

    // senha provisória = CNPJ (aceita com pontuação)
    const formatted = cnpj.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5');
    const first = await login(email, formatted);
    expect(first.statusCode).toBe(200);
    expect(first.json().mustChangePassword).toBe(true);
    const session = cookieOf(first)!;
    expect(session).toBeTruthy();
    expect(first.headers['set-cookie']).toMatch(/HttpOnly/i);
    expect(first.json()).not.toHaveProperty('token');
    const cookies = { nvs_session: session.value };

    // troca de senha não bloqueia o acesso (será feita dentro do dashboard)
    expect((await app.inject({ method: 'GET', url: '/api/v1/users', cookies })).statusCode).toBe(200);

    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      cookies,
      payload: { currentPassword: formatted, newPassword: 'MinhaSenhaNova2026' },
    });
    expect(changed.statusCode).toBe(200);
    expect(changed.json().mustChangePassword).toBe(false);

    const open = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: { nvs_session: cookieOf(changed)!.value },
    });
    expect(open.statusCode).toBe(200);
    expect(open.json().items).toHaveLength(1);

    // CNPJ não funciona mais; a senha nova sim
    expect((await login(email, cnpj)).statusCode).toBe(401);
    expect((await login(email, 'MinhaSenhaNova2026')).statusCode).toBe(200);
  });

  it('lembrar acesso gera cookie persistente; sem lembrar, cookie de sessão', async () => {
    const cnpj = randomCnpj();
    const email = `rem-${cnpj}@teste.dev`;
    await register(email, cnpj);
    const keep = await login(email, cnpj, true);
    const drop = await login(email, cnpj, false);
    expect(keep.headers['set-cookie']).toMatch(/Max-Age=2592000/i);
    expect(drop.headers['set-cookie']).not.toMatch(/Max-Age/i);
  });

  it('isola empresas: cada usuário vê apenas o próprio tenant', async () => {
    const a = randomCnpj();
    const b = randomCnpj();
    await register(`a-${a}@teste.dev`, a);
    await register(`b-${b}@teste.dev`, b);
    const sa = cookieOf(await login(`a-${a}@teste.dev`, a))!.value;
    const changed = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/change-password',
      cookies: { nvs_session: sa },
      payload: { currentPassword: a, newPassword: 'SenhaDoTenantA123' },
    });
    const users = await app.inject({
      method: 'GET',
      url: '/api/v1/users',
      cookies: { nvs_session: cookieOf(changed)!.value },
    });
    expect(users.json().items.map((u: { email: string }) => u.email)).toEqual([`a-${a}@teste.dev`]);
  });

  it('rejeita senha errada, e-mail inexistente e rota sem sessão (mesma mensagem)', async () => {
    const cnpj = randomCnpj();
    const email = `err-${cnpj}@teste.dev`;
    await register(email, cnpj);
    const wrong = await login(email, 'errada');
    const unknown = await login('nao-existe@teste.dev', 'qualquer');
    expect(wrong.statusCode).toBe(401);
    expect(unknown.statusCode).toBe(401);
    expect(wrong.json().error.message).toBe(unknown.json().error.message);
    expect((await app.inject('/api/v1/users')).statusCode).toBe(401);
  });

  it('valida CNPJ/telefone e impede cadastro duplicado', async () => {
    const bad = await register('x@teste.dev', '11111111111111', '123');
    expect(bad.statusCode).toBe(400);
    const cnpj = randomCnpj();
    expect((await register(`dup-${cnpj}@teste.dev`, cnpj)).statusCode).toBe(201);
    expect((await register(`dup-${cnpj}@teste.dev`, randomCnpj())).statusCode).toBe(409);
    expect((await register(`outro-${cnpj}@teste.dev`, cnpj)).statusCode).toBe(409);
  });

  it('recuperação de senha responde sempre 202', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/forgot-password',
      payload: { email: 'ninguem@teste.dev' },
    });
    expect(res.statusCode).toBe(202);
  });

  it('logout limpa a sessão', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/logout' });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toMatch(/nvs_session=;/);
  });

  it('onboarding: começa em welcome, exige plataforma, retoma e conclui', async () => {
    const cnpj = randomCnpj();
    const email = `onb-${cnpj}@teste.dev`;
    await register(email, cnpj);
    const cookies = { nvs_session: cookieOf(await login(email, cnpj))!.value };
    const put = (payload: object) =>
      app.inject({ method: 'PUT', url: '/api/v1/onboarding', cookies, payload });

    const initial = await app.inject({ method: 'GET', url: '/api/v1/onboarding', cookies });
    expect(initial.json()).toEqual({ step: 'welcome', marketplace: null, completed: false });

    expect((await put({ step: 'authorize' })).statusCode).toBe(400); // sem plataforma
    expect((await put({ step: 'platform', marketplace: 'shopee' })).statusCode).toBe(400); // em breve
    expect((await put({ step: 'authorize', marketplace: 'mercado_livre' })).json()).toMatchObject({
      step: 'authorize',
      marketplace: 'mercado_livre',
      completed: false,
    });

    const done = await put({ step: 'done' });
    expect(done.json()).toEqual({ step: 'done', marketplace: 'mercado_livre', completed: true });

    // concluído não volta atrás
    expect((await put({ step: 'welcome' })).json().completed).toBe(true);
    expect((await app.inject('/api/v1/onboarding')).statusCode).toBe(401);
  });

  it('dashboard: indicadores, série, top produtos, filtro por conta e isolamento', async () => {
    const cnpj = randomCnpj();
    const email = `dash-${cnpj}@teste.dev`;
    await register(email, cnpj);
    const res = await login(email, cnpj);
    const cookies = { nvs_session: cookieOf(res)!.value };
    const tenantId = res.json().tenant.id as string;

    // dois pedidos pagos hoje (conta A e B) + um cancelado, inseridos direto no banco de testes
    const db = new Database(TEST_DB!);
    const [accA, accB] = await db.withTenant(tenantId, async (c) => {
      const ids: string[] = [];
      for (const nick of ['Conta A', 'Conta B']) {
        const r = await c.query(
          `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', $2, $2) RETURNING id`,
          [tenantId, nick],
        );
        ids.push(r.rows[0].id);
      }
      const order = async (acc: string, ext: string, status: string, gross: number, fee: number, ship: number, cost: number, qty: number, sku: string) => {
        const o = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee, shipping_cost, product_cost, units)
           VALUES ($1, $2, 'mercado_livre', $3, $4, now() - interval '1 minute', $5, $6, $7, $8, $9) RETURNING id`,
          [tenantId, acc, ext, status, gross, fee, ship, cost, qty],
        );
        await c.query(
          `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, unit_cost) VALUES ($1, $2, $3, $3, $4, $5, $6)`,
          [tenantId, o.rows[0].id, sku, qty, gross / qty, cost / qty],
        );
      };
      await order(ids[0]!, 'o1', 'paid', 300, 30, 20, 100, 2, 'SKU-A');
      await order(ids[1]!, 'o2', 'paid', 100, 10, 0, 40, 1, 'SKU-B');
      await order(ids[0]!, 'o3', 'cancelled', 999, 0, 0, 0, 1, 'SKU-C');
      return ids;
    });
    await db.close();

    const get = (qs: string) =>
      app.inject({ method: 'GET', url: `/api/v1/dashboard/summary?period=today&fresh=1${qs}`, cookies });

    const all = await get('');
    expect(all.statusCode).toBe(200);
    const body = all.json();
    expect(body.kpis).toMatchObject({ revenue: 400, net: 340, grossProfit: 200, orders: 2, units: 3, avgTicket: 200 });
    expect(body.kpis.margin).toBeCloseTo(0.5);
    expect(body.granularity).toBe('hour');
    expect(body.series).toHaveLength(24);
    expect(body.series.reduce((s: number, p: { revenue: number }) => s + p.revenue, 0)).toBe(400);
    expect(body.topProducts.map((p: { sku: string }) => p.sku)).toEqual(['SKU-A', 'SKU-B']);
    expect(body.topProducts[0].share).toBeCloseTo(0.75);
    expect(body.accounts).toHaveLength(2);
    expect(body.isDemo).toBe(false);

    const onlyB = (await get(`&accountId=${accB}`)).json();
    expect(onlyB.kpis.revenue).toBe(100);
    expect(accA).toBeTruthy();

    // outra empresa não enxerga nada
    const other = randomCnpj();
    await register(`dash2-${other}@teste.dev`, other);
    const otherCookies = { nvs_session: cookieOf(await login(`dash2-${other}@teste.dev`, other))!.value };
    const iso = await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=today&fresh=1', cookies: otherCookies });
    expect(iso.json().kpis.revenue).toBe(0);
    expect(iso.json().accounts).toHaveLength(0);

    expect((await get('&period=semana')).statusCode).toBe(400);
  });

  it('excluir empresa: só com CNPJ e senha corretos; apaga tudo e libera o e-mail/CNPJ', async () => {
    const cnpj = randomCnpj();
    const email = `del-${cnpj}@teste.dev`;
    await register(email, cnpj);
    const cookies = { nvs_session: cookieOf(await login(email, cnpj))!.value };
    const del = (payload: object) => app.inject({ method: 'DELETE', url: '/api/v1/account', cookies, payload });

    expect((await del({ cnpj, password: 'errada' })).statusCode).toBe(400);
    expect((await del({ cnpj: randomCnpj(), password: cnpj })).statusCode).toBe(400);
    const ok = await del({ cnpj, password: cnpj });
    expect(ok.statusCode).toBe(204);
    expect(ok.headers['set-cookie']).toMatch(/nvs_session=;/);

    expect((await login(email, cnpj)).statusCode).toBe(401); // conta não existe mais
    expect((await register(email, cnpj)).statusCode).toBe(201); // e-mail e CNPJ liberados
  });

  it('membro comum não pode excluir a empresa', async () => {
    const cnpj = randomCnpj();
    const res = await register(`own-${cnpj}@teste.dev`, cnpj);
    expect(res.statusCode).toBe(201);
    const owner = { nvs_session: cookieOf(await login(`own-${cnpj}@teste.dev`, cnpj))!.value };
    await app.inject({
      method: 'POST',
      url: '/api/v1/users',
      cookies: owner,
      payload: { name: 'Membro', email: `mem-${cnpj}@teste.dev`, password: 'SenhaMembro123', role: 'member' },
    });
    const member = { nvs_session: cookieOf(await login(`mem-${cnpj}@teste.dev`, 'SenhaMembro123'))!.value };
    const r = await app.inject({ method: 'DELETE', url: '/api/v1/account', cookies: member, payload: { cnpj, password: 'SenhaMembro123' } });
    expect(r.statusCode).toBe(403);
  });
});
