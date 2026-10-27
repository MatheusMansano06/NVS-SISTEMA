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

describe.skipIf(!TEST_DB)('Cadastro de SKUs (custos)', () => {
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

  /** Conta com 2 vendas pagas: SKU-A (2 × 150, ontem e hoje) e SKU-B (1 × 100, hoje). */
  async function setup() {
    const cnpj = randomCnpj();
    const email = `sku-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = res.json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'Loja', '1') RETURNING id`,
        [tenantId],
      );
      const order = async (ext: string, when: string, sku: string, qty: number, price: number, fee: number) => {
        const o = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee, units)
           VALUES ($1, $2, 'mercado_livre', $3, 'paid', ${when}, $4, $5, $6) RETURNING id`,
          [tenantId, acc.rows[0].id, ext, qty * price, fee, qty],
        );
        await c.query(
          `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price) VALUES ($1, $2, $3, $3, $4, $5)`,
          [tenantId, o.rows[0].id, sku, qty, price],
        );
      };
      await order('a-hoje', "now() - interval '1 minute'", 'SKU-A', 2, 150, 30);
      await order('a-ontem', "now() - interval '1 day'", 'SKU-A', 2, 150, 30);
      await order('b-hoje', "now() - interval '1 minute'", 'SKU-B', 1, 100, 10);
    });
    return { cookies, tenantId };
  }
  const dash = (cookies: Record<string, string>, period = '7d') =>
    app.inject({ method: 'GET', url: `/api/v1/dashboard/summary?period=${period}&fresh=1`, cookies }).then((r) => r.json());
  const put = (cookies: Record<string, string>, payload: object) =>
    app.inject({ method: 'PUT', url: '/api/v1/skus', cookies, payload });
  const tax = (cookies: Record<string, string>, ratePct: number) =>
    app.inject({ method: 'PUT', url: '/api/v1/settings/tax-rate', cookies, payload: { ratePct } });

  it('primeiro custo vale para todo o histórico; alíquota única vale para todas as vendas', async () => {
    const { cookies } = await setup();
    const before = await dash(cookies);
    expect(before.missingCosts).toBe(true);
    expect(before.kpis.grossProfit).toBe(700 - 70); // sem custo: lucro = líquido

    const list = (await app.inject({ method: 'GET', url: '/api/v1/skus', cookies })).json();
    expect(list.counts).toEqual({ all: 2, done: 0, missing: 2 });
    expect(list.items.find((i: { sku: string }) => i.sku === 'SKU-A').units30d).toBe(4);

    const saved = await put(cookies, { sku: 'SKU-A', custoUnit: 40 });
    expect(saved.statusCode).toBe(200);
    expect(saved.json().affectedOrders).toBe(2); // inclusive a venda de ontem
    expect((await dash(cookies)).kpis.grossProfit).toBe(630 - 160); // SKU-A: 4 un × 40

    // alíquota da empresa: 10% sobre TODAS as vendas (inclusive SKU sem custo)
    const t = await tax(cookies, 10);
    expect(t.json()).toEqual({ ratePct: 10, vigenteDesde: '1900-01-01' });
    const after = await dash(cookies);
    expect(after.kpis.grossProfit).toBe(630 - 160 - 70);
    expect(after.missingCosts).toBe(true); // SKU-B ainda sem custo

    await put(cookies, { sku: 'SKU-B', custoUnit: 25 });
    const full = await dash(cookies);
    expect(full.missingCosts).toBe(false);
    expect(full.kpis.grossProfit).toBe(630 - 160 - 70 - 25);
    const top = full.topProducts.find((p: { sku: string }) => p.sku === 'SKU-A');
    // lucro do SKU-A = 600 - tarifas rateadas (60) - custo 160 - imposto 60
    expect(top.profit).toBeCloseTo(320, 2);
  });

  it('correção no mesmo dia vale para o histórico (custo e alíquota)', async () => {
    const { cookies } = await setup();
    await put(cookies, { sku: 'SKU-A', custoUnit: 35 });
    await put(cookies, { sku: 'SKU-A', custoUnit: 40 }); // corrigiu no mesmo dia
    await tax(cookies, 10);
    await tax(cookies, 12); // corrigiu no mesmo dia
    const yesterday = await dash(cookies, 'yesterday');
    expect(yesterday.kpis.grossProfit).toBe(300 - 30 - 80 - 36); // vale também para a venda de ontem
  });

  it('alteração em outro dia vale só daqui para frente (venda de ontem mantém o custo antigo)', async () => {
    const { cookies, tenantId } = await setup();
    await put(cookies, { sku: 'SKU-A', custoUnit: 40 });
    // simula que o primeiro custo foi cadastrado há 2 dias
    await db.withTenant(tenantId, (c) => c.query("UPDATE sku_cost_history SET registrado_em = now() - interval '2 days'"));
    await put(cookies, { sku: 'SKU-A', custoUnit: 50 });
    const yesterday = await dash(cookies, 'yesterday');
    const today = await dash(cookies, 'today');
    expect(yesterday.kpis.grossProfit).toBe(300 - 30 - 80); // 2 × 40 (custo antigo)
    expect(today.kpis.grossProfit).toBe(400 - 40 - 100); // SKU-A 2 × 50; SKU-B sem custo
    // salvar o mesmo valor não cria nova vigência nem recalcula
    expect((await put(cookies, { sku: 'SKU-A', custoUnit: 50 })).json().affectedOrders).toBe(0);
  });

  it('alíquota alterada em outro dia vale só daqui para frente (venda de ontem mantém a antiga)', async () => {
    const { cookies, tenantId } = await setup();
    await tax(cookies, 9);
    await db.withTenant(tenantId, (c) => c.query("UPDATE tax_rate_history SET registrado_em = now() - interval '2 days'"));
    expect((await tax(cookies, 12)).json().vigenteDesde).not.toBe('1900-01-01');
    const yesterday = await dash(cookies, 'yesterday');
    const today = await dash(cookies, 'today');
    expect(yesterday.kpis.grossProfit).toBe(300 - 30 - 27); // 9% de 300
    expect(today.kpis.grossProfit).toBe(400 - 40 - 48); // 12% de 400
  });

  it('valida custo e alíquota como no sistema antigo', async () => {
    const { cookies } = await setup();
    expect((await put(cookies, { sku: 'SKU-A', custoUnit: 0 })).statusCode).toBe(400);
    expect((await put(cookies, { sku: '', custoUnit: 10 })).statusCode).toBe(400);
    expect((await tax(cookies, 101)).statusCode).toBe(400);
    expect((await tax(cookies, -1)).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/v1/settings/tax-rate', cookies })).json()).toEqual({ ratePct: null, vigenteDesde: null });
  });

  it('importação CSV: pré-visualiza, rejeita tudo se houver erro, e aplica', async () => {
    const { cookies } = await setup();
    const imp = (csv: string, dryRun: boolean, ignoreUnknown = false) =>
      app.inject({ method: 'POST', url: '/api/v1/skus/import', cookies, payload: { csv, dryRun, ignoreUnknown } }).then((r) => r.json());

    const rejected = await imp('sku;custo_unit;imposto_pct\nSKU-A;40;9\nSKU-B;abc;9', false);
    expect(rejected.status).toBe('rejected');
    expect(rejected.invalidRows[0]).toMatchObject({ line: 3, sku: 'SKU-B' });
    expect((await dash(cookies)).missingCosts).toBe(true); // nada gravado

    // custo zero ou vazio é aceito (fica "sem custo"); SKU que não existe nos anúncios/vendas barra a planilha
    const zero = await imp('sku;custo_unit\nSKU-A;40\nSKU-B;0', true);
    expect(zero).toMatchObject({ status: 'dry_run', created: 1, withoutCost: 1, unknownSkus: [] });
    const unknown = await imp('sku;custo_unit\nsku-a;40\nSKU-X;10\nSKU-Y;', false);
    expect(unknown).toMatchObject({ status: 'rejected', unknownSkus: [{ line: 3, sku: 'SKU-X' }, { line: 4, sku: 'SKU-Y' }] });
    expect((await dash(cookies)).missingCosts).toBe(true);
    const skipped = await imp('sku;custo_unit\nsku-a;40\nSKU-X;10', true, true);
    expect(skipped).toMatchObject({ status: 'dry_run', created: 1, ignored: 1 }); // "sku-a" grava como "SKU-A" (grafia do anúncio)
    // mesmo SKU em outra caixa de letra não barra: fica a primeira linha e a repetida é avisada
    const dup = await imp('sku;custo_unit\nSKU-A;40\nsku-a;41\nSKU-B;10', true);
    expect(dup).toMatchObject({ status: 'dry_run', created: 2, duplicates: [{ line: 3, sku: 'sku-a', keptLine: 2 }] });

    const preview = await imp('sku;custo_unit;imposto_pct\nSKU-A;40;9\nSKU-B;25,50;9', true);
    expect(preview).toMatchObject({ status: 'dry_run', created: 2, updated: 0 });
    expect((await dash(cookies)).missingCosts).toBe(true); // dry-run não grava

    const ok = await imp('sku;custo_unit;imposto_pct\nSKU-A;40;9\nSKU-B;25,50;9', false);
    expect(ok).toMatchObject({ status: 'ok', created: 2 });
    expect((await dash(cookies)).missingCosts).toBe(false);

    const again = await imp('sku;custo_unit;imposto_pct\nSKU-A;40;9\nSKU-B;30;9', true);
    expect(again).toMatchObject({ unchanged: 1, updated: 1, created: 0 });

    const csv = await app.inject({ method: 'GET', url: '/api/v1/skus/export', cookies });
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body).toContain('"SKU-B";"SKU-B";25,50;1;'); // coluna de imposto da planilha é ignorada
  });

  it('remover custo deixa as vendas futuras sem custo, e isolamento entre empresas', async () => {
    const { cookies } = await setup();
    await put(cookies, { sku: 'SKU-A', custoUnit: 40 });
    await put(cookies, { sku: 'SKU-B', custoUnit: 20 });

    const del = await app.inject({ method: 'DELETE', url: '/api/v1/skus', cookies, payload: { sku: 'SKU-B' } });
    expect(del.statusCode).toBe(204);
    expect((await dash(cookies, 'today')).missingCosts).toBe(true);
    const list = (await app.inject({ method: 'GET', url: '/api/v1/skus?filter=missing', cookies })).json();
    expect(list.items.map((i: { sku: string }) => i.sku)).toEqual(['SKU-B']);

    const other = await setup();
    const otherList = (await app.inject({ method: 'GET', url: '/api/v1/skus?filter=done', cookies: other.cookies })).json();
    expect(otherList.items).toHaveLength(0); // custos de outra empresa não aparecem
  });
});
