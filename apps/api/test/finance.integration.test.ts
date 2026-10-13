import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { todayIn } from '../src/modules/sales/domain/period.js';

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

describe.skipIf(!TEST_DB)('Análise Financeira (regras NVS-WMS)', () => {
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
   * Pedidos de hoje (alíquota 10%):
   *  A: Full, 2×100, tarifa 24, FC 15, FV 20, cupom 10   (SKU-A, custo 40)
   *  B: ME1,  1×100, tarifa 12, FC 30, FV 0              (SKU-A)
   *  C: Coleta, 1×50, tarifa 7, FV 18                    (SKU-X, sem custo → fora da MC)
   *  D: cancelado, 1×100, FV 25                          (SKU-A)
   *  E: devolução parcial 30 em 1×100, tarifa 12, FV 10  (SKU-A)
   */
  async function setup() {
    const cnpj = randomCnpj();
    const email = `fin-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = res.json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'Loja', '1') RETURNING id`,
        [tenantId],
      );
      const add = async (ext: string, status: string, sku: string, qty: number, price: number, o: { tarifa?: number; fc?: number; fv?: number; cupom?: number; refund?: number; bucket: string }) => {
        const r = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee,
                               units, buyer_shipping, shipping_cost, coupon_seller, refund_partial, logistic_bucket, finance_enriched_at)
           VALUES ($1, $2, 'mercado_livre', $3, $4, now() - interval '1 minute', $5, $6, $7, $8, $9, $10, $11, $12, now()) RETURNING id`,
          [tenantId, acc.rows[0].id, ext, status, qty * price, o.tarifa ?? 0, qty, o.fc ?? 0, o.fv ?? 0, o.cupom ?? 0, o.refund ?? 0, o.bucket],
        );
        await c.query(
          `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price) VALUES ($1, $2, $3, $3, $4, $5)`,
          [tenantId, r.rows[0].id, sku, qty, price],
        );
      };
      await add('A', 'paid', 'SKU-A', 2, 100, { tarifa: 24, fc: 15, fv: 20, cupom: 10, bucket: 'full' });
      await add('B', 'paid', 'SKU-A', 1, 100, { tarifa: 12, fc: 30, bucket: 'me1' });
      await add('C', 'paid', 'SKU-X', 1, 50, { tarifa: 7, fv: 18, bucket: 'places_coleta' });
      await add('D', 'cancelled', 'SKU-A', 1, 100, { fv: 25, bucket: 'full' });
      await add('E', 'paid', 'SKU-A', 1, 100, { tarifa: 12, fv: 10, refund: 30, bucket: 'flex' });
    });
    await app.inject({ method: 'PUT', url: '/api/v1/settings/tax-rate', cookies, payload: { ratePct: 10 } });
    await app.inject({ method: 'PUT', url: '/api/v1/skus', cookies, payload: { sku: 'SKU-A', custoUnit: 40 } });
    return cookies;
  }
  const today = todayIn();
  const get = (cookies: Record<string, string>, path: string, extra = '') =>
    app.inject({ method: 'GET', url: `/api/v1/finance/${path}?from=${today}&to=${today}&fresh=1${extra}`, cookies });

  it('cartões, MC, composição e vendas fora por falta de custo', async () => {
    const cookies = await setup();
    const s = (await get(cookies, 'summary')).json();
    // MC (base Full/Flex = produto − cupom − devolução; ME1 inclui frete comprador):
    //  A: 200−10 −80 −19(imp 10% de 190) −24 −20 = 47
    //  B: 100+30 −40 −10 −12 −0 = 68
    //  E: 100−30 −40 −10 −12 −10 = −2   (devolução parcial)
    expect(s.cards).toMatchObject({
      vendasAprovadas: 190 + 100 + 50, // A, B, C (cartão = produto − cupom)
      vendasCanceladas: 100,
      devolucoesParciais: 70,
      faturamento: 340 + 100 + 70,
      qtdAprovadas: 3,
      qtdCanceladas: 1,
      qtdDevolucoes: 1,
      freteVendedor: 20 + 18 + 25 + 10, // conta também em cancelado e devolução
      freteComprador: 15 + 30, // só aprovadas/devoluções
      cupomSeller: 10,
      tarifa: 24 + 12 + 7 + 12,
      mcTotal: 47 + 68 - 2,
    });
    // MC% = MC ÷ base (aprovadas com custo: A 190 + B 100)
    expect(s.cards.mcPct).toBeCloseTo((113 / 290) * 100, 1);
    expect(s.semCusto).toEqual({ qtd: 1, valor: 50, skus: ['SKU-X'] });
    expect(s.composicao.map((c: { key: string }) => c.key)).toEqual(['custo', 'imposto', 'tarifa', 'frete', 'mc']);
    expect(s.breakdown.find((b: { bucket: string }) => b.bucket === 'full').valor).toBe(190);
    expect(s.series).toHaveLength(1);
  });

  it('tabela linha a linha com filtros, paginação e exportação', async () => {
    const cookies = await setup();
    const all = (await get(cookies, 'lines')).json();
    expect(all.total).toBe(5);
    const a = all.items.find((l: { orderId: string }) => l.orderId === 'A');
    expect(a).toMatchObject({ status: 'aprovada', bucket: 'full', qtd: 2, custo: 80, imposto: 19, mc: 47, cupom: 10 });

    expect((await get(cookies, 'lines', '&semCusto=true')).json().items.map((l: { orderId: string }) => l.orderId)).toEqual(['C']);
    expect((await get(cookies, 'lines', '&status=cancelada')).json().total).toBe(1);
    expect((await get(cookies, 'lines', '&margem=critico')).json().items.map((l: { orderId: string }) => l.orderId)).toEqual(['E']);
    expect((await get(cookies, 'lines', '&custo=com_custo')).json().total).toBe(4);
    expect((await get(cookies, 'lines', '&sku=sku-x')).json().items.map((l: { orderId: string }) => l.orderId)).toEqual(['C']);
    expect((await get(cookies, 'lines', '&pedido=B')).json().items.map((l: { orderId: string }) => l.orderId)).toEqual(['B']);
    const page2 = (await get(cookies, 'lines', '&limit=2&offset=2')).json();
    expect(page2.items).toHaveLength(2);
    expect(page2.total).toBe(5);

    const csv = await get(cookies, 'export');
    expect(csv.headers['content-type']).toMatch(/text\/csv/);
    expect(csv.body.split('\r\n')).toHaveLength(6);
  });

  it('"considerar frete comprador" soma o FC na base da MC em todas as modalidades', async () => {
    const cookies = await setup();
    const normal = (await get(cookies, 'summary')).json().cards.mcTotal;
    const comFc = (await get(cookies, 'summary', '&considerarFreteComprador=true')).json().cards.mcTotal;
    expect(comFc).toBe(normal + 15); // pedido A (Full) passa a contar o frete comprador de 15
  });

  it('valida o período', async () => {
    const cookies = await setup();
    const bad = await app.inject({ method: 'GET', url: '/api/v1/finance/summary?from=2026-10-10&to=2026-01-01', cookies });
    expect(bad.statusCode).toBe(400);
  });
});
