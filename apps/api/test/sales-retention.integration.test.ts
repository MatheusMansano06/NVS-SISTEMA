import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { retentionCutoff } from '../src/modules/sales/index.js';

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

describe('retentionCutoff', () => {
  it('mantém o mês atual + 13 meses completos', () => {
    expect(retentionCutoff('2026-10-13')).toBe('2025-09-01');
    expect(retentionCutoff('2026-01-31')).toBe('2024-12-01');
  });
});

describe.skipIf(!TEST_DB)('Retenção das vendas', () => {
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

  async function company() {
    const cnpj = randomCnpj();
    const email = `ret-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const tenantId = res.json().tenant.id as string;
    await db.withTenant(tenantId, async (c) => {
      const acc = await c.query(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'Loja', $2) RETURNING id`,
        [tenantId, cnpj],
      );
      const order = async (ext: string, when: string, items: [string, number, number, number | null][], fee: number) => {
        const gross = items.reduce((s, [, q, p]) => s + q * p, 0);
        const o = await c.query(
          `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at, gross_amount, marketplace_fee,
                               shipping_cost, units, payment_type, ship_state, tax_amount)
           VALUES ($1, $2, 'mercado_livre', $3, 'paid', $4::timestamptz, $5, $6, 10, 1, 'credit_card', 'BA', 9) RETURNING id`,
          [tenantId, acc.rows[0].id, ext, when, gross, fee],
        );
        for (const [sku, q, p, cost] of items) {
          await c.query(
            `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, unit_cost, listing_id) VALUES ($1, $2, $3, $3, $4, $5, $6, 'MLB1')`,
            [tenantId, o.rows[0].id, sku, q, p, cost],
          );
        }
      };
      // 2 vendas antigas (mar/2024) e 1 recente
      await order('OLD1', '2024-03-10T15:00:00-03:00', [['A', 1, 100, 40]], 12);
      await order('OLD2', '2024-03-20T15:00:00-03:00', [['A', 1, 100, 40], ['B', 1, 100, null]], 24);
      await order('NEW', new Date().toISOString(), [['A', 1, 100, 40]], 12);
    });
    return tenantId;
  }

  it('arquiva o que passou de 13 meses em totais e apaga o detalhe; rodar de novo não duplica', async () => {
    const tenantId = await company();
    const done = await app.retention.archiveTenant(tenantId);
    expect(done).toEqual(['2024-03-01']);
    await app.retention.archiveTenant(tenantId); // idempotente

    const { orders, totals } = await db.withTenant(tenantId, async (c) => ({
      orders: (await c.query('SELECT external_id FROM orders ORDER BY 1')).rows.map((r) => r.external_id),
      totals: (await c.query("SELECT sku, orders, units, gross::float, fee::float, cost::float, cost_known FROM sales_monthly_totals WHERE month = '2024-03-01' ORDER BY sku")).rows,
    }));
    expect(orders).toEqual(['NEW']);
    expect(totals).toEqual([
      // A: OLD1 (tarifa 12) + metade de OLD2 (24 × 50%) = 24
      { sku: 'A', orders: 2, units: 2, gross: 200, fee: 24, cost: 80, cost_known: true },
      { sku: 'B', orders: 1, units: 1, gross: 100, fee: 12, cost: 0, cost_known: false },
    ]);
  });
});
