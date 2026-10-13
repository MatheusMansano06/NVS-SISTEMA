import type { PaymentGroup } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { TIMEZONE, type DateRange } from '../domain/period.js';

export interface SalesFilter {
  range: DateRange;
  accountId?: string;
  listingId?: string;
}

const PAYMENT_TYPES: Record<Exclude<PaymentGroup, 'other'>, string[]> = {
  pix: ['bank_transfer', 'pix'],
  credit: ['credit_card'],
  debit: ['debit_card', 'prepaid_card'],
  balance: ['account_money'],
};
const KNOWN_TYPES = Object.values(PAYMENT_TYPES).flat();

/**
 * Pedidos do período no nível do item, com tarifa/frete/imposto/cupom/devolução rateados pela participação
 * do item no pedido. Filtrar por anúncio considera só os itens dele. Lucro = produto − cupom − devolução −
 * tarifa − frete − imposto − custo (custo desconhecido = lucro desconhecido).
 */
function ordersCte(f: SalesFilter, params: unknown[]): string {
  params.push(f.range.from, f.range.to);
  const where = [`(o.ordered_at AT TIME ZONE '${TIMEZONE}')::date BETWEEN $1 AND $2`];
  if (f.accountId) {
    params.push(f.accountId);
    where.push(`o.account_id = $${params.length}`);
  }
  if (f.listingId) {
    params.push(f.listingId);
    where.push(`i.listing_id = $${params.length}`);
  }
  return `
    WITH lines AS (
      SELECT o.id, o.external_id, o.ordered_at, o.status, o.payment_type, o.installments, o.logistic_bucket,
             o.ship_state, o.ship_city, o.ship_zip, o.buyer_nickname, o.pack_id,
             i.quantity, i.quantity * i.unit_price AS gross,
             o.marketplace_fee * s.share AS fee, o.shipping_cost * s.share AS freight, o.tax_amount * s.share AS tax,
             (coalesce(o.coupon_seller, 0) + coalesce(o.refund_partial, 0)) * s.share AS deductions,
             i.unit_cost * i.quantity AS cost
        FROM orders o
        JOIN order_items i ON i.order_id = o.id
        CROSS JOIN LATERAL (SELECT coalesce(i.quantity * i.unit_price / nullif(o.gross_amount, 0), 1) AS share) s
       WHERE ${where.join(' AND ')}
    ), ord AS (
      SELECT id, external_id, ordered_at, status, payment_type, installments, logistic_bucket, ship_state, ship_city,
             ship_zip, buyer_nickname, pack_id,
             sum(quantity) AS units, round(sum(gross), 2) AS gross, round(sum(fee), 2) AS fee,
             round(sum(freight), 2) AS freight, round(sum(tax), 2) AS tax,
             CASE WHEN bool_and(cost IS NOT NULL) THEN round(sum(cost), 2) END AS cost,
             round(sum(gross) - sum(deductions) - sum(fee) - sum(freight) - sum(tax) - sum(cost), 2) AS profit
        FROM lines
       GROUP BY id, external_id, ordered_at, status, payment_type, installments, logistic_bucket, ship_state, ship_city,
                ship_zip, buyer_nickname, pack_id
    )`;
}

const n = (v: string | null) => (v === null ? null : Number(v));

export class PgSalesAnalyticsRepository {
  async overview(db: Queryable, f: SalesFilter) {
    const params: unknown[] = [];
    const cte = ordersCte(f, params);
    const q = <T extends Record<string, unknown>>(sql: string) => db.query<T>(`${cte} ${sql}`, params).then((r) => r.rows);

    const [k] = await q<{ orders: string; units: string; revenue: string; profit: string | null; known: boolean; cancelled: string }>(
      `SELECT count(*) FILTER (WHERE status = 'paid') AS orders,
              coalesce(sum(units) FILTER (WHERE status = 'paid'), 0) AS units,
              coalesce(sum(gross) FILTER (WHERE status = 'paid'), 0) AS revenue,
              sum(profit) FILTER (WHERE status = 'paid') AS profit,
              coalesce(bool_and(cost IS NOT NULL) FILTER (WHERE status = 'paid'), true) AS known,
              count(*) FILTER (WHERE status <> 'paid') AS cancelled
         FROM ord`,
    );
    const payments = await q<{ payment_type: string | null; orders: string }>(
      `SELECT payment_type, count(*) AS orders FROM ord WHERE status = 'paid' GROUP BY 1`,
    );
    const shipping = await q<{ bucket: string | null; orders: string }>(
      `SELECT coalesce(logistic_bucket, 'outros') AS bucket, count(*) AS orders FROM ord WHERE status = 'paid' GROUP BY 1 ORDER BY 2 DESC`,
    );
    const states = await q<{ uf: string; orders: string; revenue: string }>(
      `SELECT ship_state AS uf, count(*) AS orders, sum(gross) AS revenue
         FROM ord WHERE status = 'paid' AND ship_state IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 3 DESC`,
    );
    const months = await q<{ month: string; orders: string; revenue: string; profit: string | null; known: boolean }>(
      `SELECT to_char(ordered_at AT TIME ZONE '${TIMEZONE}', 'YYYY-MM') AS month, count(*) AS orders, sum(gross) AS revenue,
              sum(profit) AS profit, bool_and(cost IS NOT NULL) AS known
         FROM ord WHERE status = 'paid' GROUP BY 1 ORDER BY 1 DESC`,
    );
    const monthStates = await q<{ month: string; uf: string; orders: string; revenue: string }>(
      `SELECT to_char(ordered_at AT TIME ZONE '${TIMEZONE}', 'YYYY-MM') AS month, ship_state AS uf,
              count(*) AS orders, sum(gross) AS revenue
         FROM ord WHERE status = 'paid' AND ship_state IS NOT NULL GROUP BY 1, 2`,
    );
    return {
      kpis: {
        orders: Number(k!.orders),
        units: Number(k!.units),
        revenue: Number(k!.revenue),
        profit: k!.known ? n(k!.profit) ?? 0 : null,
        cancelled: Number(k!.cancelled),
      },
      payments: payments.map((r) => ({ type: r.payment_type, orders: Number(r.orders) })),
      shipping: shipping.map((r) => ({ bucket: r.bucket ?? 'outros', orders: Number(r.orders) })),
      states: states.map((r) => ({ uf: r.uf, orders: Number(r.orders), revenue: Number(r.revenue) })),
      months: months.map((r) => ({ month: r.month, orders: Number(r.orders), revenue: Number(r.revenue), profit: r.known ? n(r.profit) ?? 0 : null })),
      monthStates: monthStates.map((r) => ({ month: r.month, uf: r.uf, orders: Number(r.orders), revenue: Number(r.revenue) })),
    };
  }

  async orders(db: Queryable, f: SalesFilter & { q?: string; payment?: PaymentGroup; offset: number; limit: number }) {
    const params: unknown[] = [];
    const cte = ordersCte(f, params);
    const where: string[] = [];
    if (f.payment) {
      if (f.payment === 'other') {
        params.push(KNOWN_TYPES);
        where.push(`(payment_type IS NULL OR NOT payment_type = ANY($${params.length}))`);
      } else {
        params.push(PAYMENT_TYPES[f.payment]);
        where.push(`payment_type = ANY($${params.length})`);
      }
    }
    if (f.q) {
      params.push(`%${f.q.replace(/[\\%_]/g, '\\$&')}%`);
      const p = `$${params.length}`;
      where.push(`(external_id ILIKE ${p} OR buyer_nickname ILIKE ${p} OR pack_id ILIKE ${p} OR ship_zip ILIKE ${p}
                   OR ship_city ILIKE ${p} OR EXISTS (SELECT 1 FROM order_items x WHERE x.order_id = ord.id AND (x.title ILIKE ${p} OR x.sku ILIKE ${p})))`);
    }
    const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const total = await db.query<{ n: string }>(`${cte} SELECT count(*) AS n FROM ord ${filter}`, params);
    params.push(f.limit, f.offset);
    const { rows } = await db.query<{
      id: string; external_id: string; ordered_at: Date; status: 'paid' | 'cancelled' | 'returned'; payment_type: string | null;
      installments: number | null; logistic_bucket: string | null; ship_state: string | null; ship_city: string | null;
      ship_zip: string | null; buyer_nickname: string | null; pack_id: string | null; gross: string; fee: string;
      freight: string; tax: string; cost: string | null; profit: string | null;
    }>(`${cte} SELECT * FROM ord ${filter} ORDER BY ordered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`, params);
    const items = rows.length
      ? (
          await db.query<{ order_id: string; title: string; sku: string; quantity: number; unit_price: string; listing_id: string | null }>(
            `SELECT order_id, title, sku, quantity, unit_price, listing_id FROM order_items WHERE order_id = ANY($1)
              ${f.listingId ? 'AND listing_id = $2' : ''}`,
            f.listingId ? [rows.map((r) => r.id), f.listingId] : [rows.map((r) => r.id)],
          )
        ).rows
      : [];
    return { rows, items, total: Number(total.rows[0]!.n) };
  }

  /** DIFAL cobrado nas faturas do ML por mês (AAAA-MM), das contas filtradas. */
  async billedDifal(db: Queryable, fromMonth: string, toMonth: string, accountId?: string) {
    const { rows } = await db.query<{ month: string; amount: string }>(
      `SELECT to_char(period_key, 'YYYY-MM') AS month, sum(difal) AS amount
         FROM ml_billing_periods
        WHERE to_char(period_key, 'YYYY-MM') BETWEEN $1 AND $2 ${accountId ? 'AND account_id = $3' : ''}
        GROUP BY 1 ORDER BY 1 DESC`,
      accountId ? [fromMonth, toMonth, accountId] : [fromMonth, toMonth],
    );
    return rows.map((r) => ({ month: r.month, amount: Number(r.amount) }));
  }

  async listing(db: Queryable, externalId: string) {
    const { rows } = await db.query<{ external_id: string; title: string; sku: string | null; picture_url: string | null; available_quantity: number | null; sold_quantity: number | null }>(
      `SELECT external_id, title, sku, picture_url, available_quantity, sold_quantity FROM listings WHERE external_id = $1 LIMIT 1`,
      [externalId],
    );
    return rows[0] ?? null;
  }

  async difalSettings(db: Queryable) {
    const { rows } = await db.query<{ origin_uf: string; imported: boolean; internal_rates: Record<string, number> }>(
      'SELECT origin_uf, imported, internal_rates FROM difal_settings LIMIT 1',
    );
    return rows[0] ?? null;
  }

  async saveDifalSettings(db: Queryable, tenantId: string, userId: string, s: { originUf: string; imported: boolean; internalRates: Record<string, number> }) {
    await db.query(
      `INSERT INTO difal_settings (tenant_id, origin_uf, imported, internal_rates, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (tenant_id) DO UPDATE SET origin_uf = EXCLUDED.origin_uf, imported = EXCLUDED.imported,
         internal_rates = EXCLUDED.internal_rates, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, s.originUf, s.imported, JSON.stringify(s.internalRates), userId],
    );
  }
}
