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

describe.skipIf(!TEST_DB)('Aba Vendas', () => {
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

  /** 3 vendas pagas (SP Pix, BA crédito, PR saldo) + 1 cancelada; a de BA tem 2 itens (anúncios A e B). */
  async function company() {
    const cnpj = randomCnpj();
    const email = `vendas-${cnpj}@teste.dev`;
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
      const order = async (ext: string, status: string, gross: number, fee: number, ship: number, pay: string, uf: string | null, items: [string, string, number, number, number | null][]) => {
        const o = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee,
                               shipping_cost, units, payment_type, ship_state, ship_city, buyer_nickname, logistic_bucket)
           VALUES ($1, $2, 'mercado_livre', $3, $4, now() - interval '1 day', $5, $6, $7, 1, $8, $9, 'Cidade', 'COMPRADOR_' || $3, 'full')
           RETURNING id`,
          [tenantId, a, ext, status, gross, fee, ship, pay, uf],
        );
        for (const [listing, sku, qty, price, cost] of items) {
          await c.query(
            `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, unit_cost, listing_id)
             VALUES ($1, $2, $3, $3, $4, $5, $6, $7)`,
            [tenantId, o.rows[0].id, sku, qty, price, cost, listing],
          );
        }
      };
      await order('V1', 'paid', 100, 10, 10, 'bank_transfer', 'SP', [['MLB1', 'A', 1, 100, 40]]);
      await order('V2', 'paid', 200, 20, 20, 'credit_card', 'BA', [['MLB1', 'A', 1, 100, 40], ['MLB2', 'B', 1, 100, 50]]);
      await order('V3', 'paid', 100, 10, 0, 'account_money', 'PR', [['MLB2', 'B', 1, 100, 50]]);
      await order('V4', 'cancelled', 100, 0, 0, 'credit_card', 'RJ', [['MLB1', 'A', 1, 100, 40]]);
    });
    return { cookies };
  }

  it('visão geral de todos os anúncios: KPIs, pagamento, estados e DIFAL', async () => {
    const { cookies } = await company();
    const r = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=7d', cookies })).json();
    expect(r.kpis).toMatchObject({ orders: 3, units: 4, revenue: 400, cancelled: 1 });
    // lucro: 400 − tarifa 40 − frete 30 − custo 180 = 150
    expect(r.kpis.profit).toBe(150);
    expect(r.payments).toEqual(expect.arrayContaining([{ group: 'pix', orders: 1 }, { group: 'credit', orders: 1 }, { group: 'balance', orders: 1 }]));
    expect(r.located).toEqual({ orders: 3, total: 3 });
    // BA 200 × 13,5% = 27 ; PR 100 × 7,5% = 7,5
    expect(r.difal.total).toBe(34.5);
  });

  it('filtra por anúncio (só os itens dele) e lista pedidos com busca e forma de pagamento', async () => {
    const { cookies } = await company();
    const a = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=7d&listingId=MLB1', cookies })).json();
    expect(a.kpis).toMatchObject({ orders: 2, units: 2, revenue: 200 });
    // V2 tem 2 itens: só metade de tarifa/frete vai para o anúncio A
    const list = (await app.inject({ method: 'GET', url: '/api/v1/sales/orders?period=7d&listingId=MLB1', cookies })).json();
    const v2 = list.items.find((o: { id: string }) => o.id === 'V2');
    expect(v2).toMatchObject({ revenue: 100, fee: 10, freight: 10, cost: 40, profit: 40, payment: 'credit', uf: 'BA' });
    expect(v2.items).toHaveLength(1);
    const pix = (await app.inject({ method: 'GET', url: '/api/v1/sales/orders?period=7d&payment=pix', cookies })).json();
    expect(pix.items.map((o: { id: string }) => o.id)).toEqual(['V1']);
    const busca = (await app.inject({ method: 'GET', url: '/api/v1/sales/orders?period=7d&q=COMPRADOR_V3', cookies })).json();
    expect(busca.total).toBe(1);
  });

  it('configuração do DIFAL é por empresa e muda o cálculo', async () => {
    const a = await company();
    const b = await company();
    const put = await app.inject({
      method: 'PUT',
      url: '/api/v1/settings/difal',
      cookies: a.cookies,
      payload: { originUf: 'SP', imported: true, internalRates: { BA: 20.5 } },
    });
    expect(put.json()).toMatchObject({ originUf: 'SP', imported: true });
    // importado: 4% → BA 16,5% de 200 = 33 ; PR 15,5% de 100 = 15,5
    const ra = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=7d', cookies: a.cookies })).json();
    expect(ra.difal.total).toBe(48.5);
    const rb = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=7d', cookies: b.cookies })).json();
    expect(rb.difal.settings.imported).toBe(false);
    expect(rb.kpis.orders).toBe(3); // só as próprias vendas
  });
});
