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

const cookieOf = (res: { cookies: { name: string; value: string }[] }, name: string) => res.cookies.find((c) => c.name === name);

describe.skipIf(!TEST_DB)('Equipe: nome + PIN na Análise e na Operação', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
  });
  afterAll(() => app.close());

  type Member = { name: string; area: 'analise' | 'operacao' | 'ambos'; master?: boolean };
  /** Conta criada já com a equipe; devolve a sessão da empresa. */
  async function company(team?: Member[]) {
    const cnpj = randomCnpj();
    const email = `eq-${cnpj}@teste.dev`;
    const reg = await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj, team } });
    expect(reg.statusCode).toBe(201);
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { nvs_session: cookieOf(res, 'nvs_session')!.value };
  }
  const get = (url: string, cookies: Record<string, string>) => app.inject({ method: 'GET', url, cookies });
  const post = (url: string, cookies: Record<string, string>, payload: object = {}) => app.inject({ method: "POST", url, cookies, payload: payload as Record<string, unknown> });
  async function enter(c: Record<string, string>, name: string, mode: 'analise' | 'operacao', pin = '1234') {
    const team = (await get('/api/v1/team', c)).json();
    const m = team.members.find((x: { name: string }) => x.name === name);
    const res = await post('/api/v1/team/login', c, { operatorId: m.id, pin, mode });
    return { res, cookies: res.statusCode === 200 ? { ...c, nvs_person: cookieOf(res, 'nvs_person')!.value } : c, id: m.id as string };
  }

  it('cadastro da conta com a equipe → escolhe o nome → PIN 1234 → troca opcional', async () => {
    const c = await company([
      { name: 'Ana', area: 'analise', master: true },
      { name: 'João', area: 'operacao' },
      { name: 'Bia', area: 'ambos' },
    ]);
    const team = (await get('/api/v1/team', c)).json();
    expect(team.setupNeeded).toBe(false);
    expect(team.members.map((m: { name: string }) => m.name)).toEqual(['Ana', 'Bia', 'João']);

    const ana = await enter(c, 'Ana', 'analise');
    expect(ana.res.json()).toMatchObject({ person: { name: 'Ana', master: true, defaultPin: true }, mode: 'analise' });
    expect((await get('/api/v1/team/me', ana.cookies)).json().person.name).toBe('Ana');

    // função: João é só da Operação
    expect((await enter(c, 'João', 'analise')).res.statusCode).toBe(403);
    expect((await enter(c, 'João', 'operacao')).res.statusCode).toBe(200);
    expect((await enter(c, 'Bia', 'analise')).res.statusCode).toBe(200);

    // trocar o PIN é opcional; regras do novo PIN
    expect((await post('/api/v1/team/pin', ana.cookies, { current: '1234', next: '0000' })).statusCode).toBe(400);
    const ok = await post('/api/v1/team/pin', ana.cookies, { current: '1234', next: '4826' });
    expect(ok.json().person.defaultPin).toBe(false);
    expect((await enter(c, 'Ana', 'analise', '4826')).res.statusCode).toBe(200);

    // sair da empresa derruba a pessoa também
    const out = await post('/api/v1/auth/logout', ana.cookies);
    expect(cookieOf(out, 'nvs_person')!.value).toBe('');
  });

  it('só MASTER cadastra a equipe (na Análise ou na Operação) e sempre fica um MASTER', async () => {
    const c = await company([
      { name: 'Ana', area: 'analise', master: true },
      { name: 'João', area: 'operacao' },
    ]);
    const joao = await enter(c, 'João', 'operacao');
    expect((await post('/api/v1/team/members', joao.cookies, { name: 'Zé', area: 'operacao' })).statusCode).toBe(403);
    expect((await post('/api/v1/team/members', c, { name: 'Zé', area: 'operacao' })).statusCode).toBe(401); // sem PIN

    const ana = await enter(c, 'Ana', 'analise');
    const ze = await post('/api/v1/team/members', ana.cookies, { name: 'Zé', area: 'operacao', master: true });
    expect(ze.statusCode).toBe(201);
    expect(ze.json()).toMatchObject({ name: 'Zé', area: 'operacao', master: true, defaultPin: true });
    expect((await post('/api/v1/team/members', ana.cookies, { name: 'zé', area: 'analise' })).statusCode).toBe(409);

    // MASTER da Operação também cadastra
    const zeIn = await enter(c, 'Zé', 'operacao');
    expect((await post('/api/v1/team/members', zeIn.cookies, { name: 'Lia', area: 'ambos' })).statusCode).toBe(201);

    // não dá para ficar sem MASTER
    await app.inject({ method: 'PATCH', url: `/api/v1/team/members/${zeIn.id}`, cookies: ana.cookies, payload: { master: false } });
    const last = await app.inject({ method: 'PATCH', url: `/api/v1/team/members/${ana.id}`, cookies: ana.cookies, payload: { active: false } });
    expect(last.statusCode).toBe(400);

    // João vira só Análise: a sessão dele na Operação cai
    await app.inject({ method: 'PATCH', url: `/api/v1/team/members/${joao.id}`, cookies: ana.cookies, payload: { area: 'analise' } });
    expect((await get('/api/v1/team/me', joao.cookies)).statusCode).toBe(401);
  });

  it('conta antiga sem equipe: setup uma vez; bloqueio por PIN errado; empresas isoladas', async () => {
    const c = await company();
    expect((await get('/api/v1/team', c)).json()).toMatchObject({ setupNeeded: true, members: [] });
    expect((await post('/api/v1/team/setup', c, [{ name: 'Rui', area: 'ambos', master: false }])).statusCode).toBe(400);
    expect((await post('/api/v1/team/setup', c, [{ name: 'Rui', area: 'ambos', master: true }])).statusCode).toBe(204);
    expect((await post('/api/v1/team/setup', c, [{ name: 'Outro', area: 'ambos', master: true }])).statusCode).toBe(403);

    const team = (await get('/api/v1/team', c)).json();
    const rui = team.members[0].id;
    for (let i = 0; i < 4; i++) {
      expect((await post('/api/v1/team/login', c, { operatorId: rui, pin: '9999', mode: 'analise' })).statusCode).toBe(401);
    }
    await post('/api/v1/team/login', c, { operatorId: rui, pin: '9999', mode: 'analise' });
    expect((await post('/api/v1/team/login', c, { operatorId: rui, pin: '1234', mode: 'analise' })).statusCode).toBe(423);

    // outra empresa não usa a pessoa nem o cookie desta
    const other = await company([{ name: 'X', area: 'ambos', master: true }]);
    expect((await post('/api/v1/team/login', other, { operatorId: rui, pin: '1234', mode: 'analise' })).statusCode).toBe(401);
    const x = await enter(other, 'X', 'analise');
    expect((await get('/api/v1/team/me', { ...c, nvs_person: x.cookies.nvs_person! })).statusCode).toBe(401);
    // cookie da pessoa não vale como sessão da empresa
    expect((await get('/api/v1/auth/me', { nvs_session: x.cookies.nvs_person! })).statusCode).toBe(401);
  });
});
