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

describe.skipIf(!TEST_DB)('Operação: operadores e PIN', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
  });
  afterAll(() => app.close());

  async function analyst() {
    const cnpj = randomCnpj();
    const email = `op-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { nvs_session: cookieOf(res, 'nvs_session')!.value };
  }

  it('fluxo completo: cadastro → computador em modo Operação → PIN 1234 → troca obrigatória', async () => {
    const a = await analyst();
    const created = await app.inject({ method: 'POST', url: '/api/v1/operators', cookies: a, payload: { name: 'João' } });
    expect(created.statusCode).toBe(201);
    const op = created.json();
    expect(op).toMatchObject({ name: 'João', mustChangePin: true, active: true });
    const dup = await app.inject({ method: 'POST', url: '/api/v1/operators', cookies: a, payload: { name: 'joão' } });
    expect(dup.statusCode).toBe(409);

    // a Análise coloca o computador em modo Operação: a sessão da Análise é encerrada aqui
    const start = await app.inject({ method: 'POST', url: '/api/v1/station/start', cookies: a });
    expect(start.statusCode).toBe(204);
    const station = { nvs_station: cookieOf(start, 'nvs_station')!.value };
    expect(cookieOf(start, 'nvs_session')!.value).toBe('');

    const st = (await app.inject({ method: 'GET', url: '/api/v1/station', cookies: station })).json();
    expect(st.operators).toEqual([{ id: op.id, name: 'João' }]);

    const login = await app.inject({ method: 'POST', url: '/api/v1/station/login', cookies: station, payload: { operatorId: op.id, pin: '1234' } });
    expect(login.json().operator).toMatchObject({ name: 'João', mustChangePin: true });
    const opCookie = { nvs_op: cookieOf(login, 'nvs_op')!.value };

    // trocar o PIN: regras
    const bad = await app.inject({ method: 'POST', url: '/api/v1/operator/pin', cookies: opCookie, payload: { current: '1234', next: '1234' } });
    expect(bad.statusCode).toBe(400);
    const rep = await app.inject({ method: 'POST', url: '/api/v1/operator/pin', cookies: opCookie, payload: { current: '1234', next: '0000' } });
    expect(rep.statusCode).toBe(400);
    const ok = await app.inject({ method: 'POST', url: '/api/v1/operator/pin', cookies: opCookie, payload: { current: '1234', next: '4826' } });
    expect(ok.json().operator.mustChangePin).toBe(false);
    const again = await app.inject({ method: 'POST', url: '/api/v1/station/login', cookies: station, payload: { operatorId: op.id, pin: '4826' } });
    expect(again.statusCode).toBe(200);
  });

  it('token da Operação não abre nada da Análise', async () => {
    const a = await analyst();
    const op = (await app.inject({ method: 'POST', url: '/api/v1/operators', cookies: a, payload: { name: 'Maria' } })).json();
    const start = await app.inject({ method: 'POST', url: '/api/v1/station/start', cookies: a });
    const stationTok = cookieOf(start, 'nvs_station')!.value;
    const login = await app.inject({ method: 'POST', url: '/api/v1/station/login', cookies: { nvs_station: stationTok }, payload: { operatorId: op.id, pin: '1234' } });
    const opTok = cookieOf(login, 'nvs_op')!.value;
    for (const tok of [stationTok, opTok]) {
      // mesmo colando o token no cookie da Análise ou no cabeçalho
      expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary', cookies: { nvs_session: tok } })).statusCode).toBe(401);
      expect((await app.inject({ method: 'GET', url: '/api/v1/operators', headers: { authorization: `Bearer ${tok}` } })).statusCode).toBe(401);
    }
    // e o operador não lista outro computador sem o cookie da estação
    expect((await app.inject({ method: 'GET', url: '/api/v1/station', cookies: { nvs_op: opTok } })).statusCode).toBe(401);
  });

  it('5 PINs errados bloqueiam; a Análise reseta para 1234; outra empresa não enxerga', async () => {
    const a = await analyst();
    const op = (await app.inject({ method: 'POST', url: '/api/v1/operators', cookies: a, payload: { name: 'Pedro' } })).json();
    const start = await app.inject({ method: 'POST', url: '/api/v1/station/start', cookies: a });
    const station = { nvs_station: cookieOf(start, 'nvs_station')!.value };
    const tryPin = (pin: string) => app.inject({ method: 'POST', url: '/api/v1/station/login', cookies: station, payload: { operatorId: op.id, pin } });
    for (let i = 0; i < 5; i++) expect((await tryPin('9999')).statusCode).toBe(401);
    const locked = await tryPin('1234');
    expect(locked.statusCode).toBe(423);

    const a2 = await analyst(); // a sessão anterior foi encerrada pelo modo Operação
    expect((await app.inject({ method: 'GET', url: '/api/v1/operators', cookies: a2 })).json()).toEqual([]);

    // a própria empresa reseta (precisa entrar de novo: o computador virou estação)
    const relog = await app.inject({ method: 'GET', url: '/api/v1/operators', cookies: a });
    expect(relog.statusCode).toBe(200); // o cookie antigo continua válido fora deste computador
    expect((await app.inject({ method: 'POST', url: `/api/v1/operators/${op.id}/reset-pin`, cookies: a })).statusCode).toBe(204);
    expect((await tryPin('1234')).statusCode).toBe(200);
  });
});
