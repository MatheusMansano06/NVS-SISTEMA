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
  // limites como instantes (meia-noite de São Paulo): usa o índice (tenant_id, ordered_at)
  const where = [
    `o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'`,
    `o.ordered_at < ($2::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'`,
  ];
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
    ), ord AS MATERIALIZED (
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
  /** Tudo da visão geral numa consulta só: a base (CTE) é calculada uma vez e reaproveitada. */
  async overview(db: Queryable, f: SalesFilter) {
    const params: unknown[] = [];
    const cte = ordersCte(f, params);
    const month = `to_char(ordered_at AT TIME ZONE '${TIMEZONE}', 'YYYY-MM')`;
    const { rows } = await db.query<{
      kpis: { orders: number; units: number; revenue: number; profit: number | null; known: boolean };
      cancelled: number;
      payments: { payment_type: string | null; orders: number }[];
      shipping: { bucket: string; orders: number }[];
      states: { uf: string; orders: number; revenue: number }[];
      months: { month: string; orders: number; revenue: number; profit: number | null; known: boolean }[];
      month_states: { month: string; uf: string; orders: number; revenue: number }[];
    }>(
      `${cte}, paid AS (SELECT * FROM ord WHERE status = 'paid')
       SELECT
         (SELECT json_build_object('orders', count(*), 'units', coalesce(sum(units), 0), 'revenue', coalesce(sum(gross), 0),
                                   'profit', sum(profit), 'known', coalesce(bool_and(cost IS NOT NULL), true)) FROM paid) AS kpis,
         (SELECT count(*)::int FROM ord WHERE status <> 'paid') AS cancelled,
         (SELECT coalesce(json_agg(x), '[]') FROM (SELECT payment_type, count(*) AS orders FROM paid GROUP BY 1) x) AS payments,
         (SELECT coalesce(json_agg(x ORDER BY x.orders DESC), '[]') FROM
            (SELECT coalesce(logistic_bucket, 'outros') AS bucket, count(*) AS orders FROM paid GROUP BY 1) x) AS shipping,
         (SELECT coalesce(json_agg(x ORDER BY x.orders DESC, x.revenue DESC), '[]') FROM
            (SELECT ship_state AS uf, count(*) AS orders, sum(gross) AS revenue FROM paid WHERE ship_state IS NOT NULL GROUP BY 1) x) AS states,
         (SELECT coalesce(json_agg(x ORDER BY x.month DESC), '[]') FROM
            (SELECT ${month} AS month, count(*) AS orders, sum(gross) AS revenue, sum(profit) AS profit,
                    bool_and(cost IS NOT NULL) AS known FROM paid GROUP BY 1) x) AS months,
         (SELECT coalesce(json_agg(x), '[]') FROM
            (SELECT ${month} AS month, ship_state AS uf, count(*) AS orders, sum(gross) AS revenue
               FROM paid WHERE ship_state IS NOT NULL GROUP BY 1, 2) x) AS month_states`,
      params,
    );
    const r = rows[0]!;
    const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
    return {
      kpis: {
        orders: Number(r.kpis.orders),
        units: Number(r.kpis.units),
        revenue: Number(r.kpis.revenue),
        profit: r.kpis.known ? n(r.kpis.profit) ?? 0 : null,
        cancelled: Number(r.cancelled),
      },
      payments: r.payments.map((x) => ({ type: x.payment_type, orders: Number(x.orders) })),
      shipping: r.shipping.map((x) => ({ bucket: x.bucket, orders: Number(x.orders) })),
      states: r.states.map((x) => ({ uf: x.uf, orders: Number(x.orders), revenue: Number(x.revenue) })),
      months: r.months.map((x) => ({ month: x.month, orders: Number(x.orders), revenue: Number(x.revenue), profit: x.known ? n(x.profit) ?? 0 : null })),
      monthStates: r.month_states.map((x) => ({ month: x.month, uf: x.uf, orders: Number(x.orders), revenue: Number(x.revenue) })),
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
    params.push(f.limit, f.offset);
    const { rows } = await db.query<{
      id: string; external_id: string; ordered_at: Date; status: 'paid' | 'cancelled' | 'returned'; payment_type: string | null;
      installments: number | null; logistic_bucket: string | null; ship_state: string | null; ship_city: string | null;
      ship_zip: string | null; buyer_nickname: string | null; pack_id: string | null; gross: string; fee: string;
      freight: string; tax: string; cost: string | null; profit: string | null; total_count: string;
    }>(
      // contagem e página na mesma consulta (a base não é recalculada)
      `${cte} SELECT *, count(*) OVER () AS total_count FROM ord ${filter}
        ORDER BY ordered_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    // página além do fim: conta à parte (raro)
    const total = rows.length
      ? Number(rows[0]!.total_count)
      : f.offset
        ? Number((await db.query<{ n: string }>(`${cte} SELECT count(*) AS n FROM ord ${filter}`, params.slice(0, -2))).rows[0]!.n)
        : 0;
    const items = rows.length
      ? (
          await db.query<{ order_id: string; title: string; sku: string; quantity: number; unit_price: string; listing_id: string | null }>(
            `SELECT order_id, title, sku, quantity, unit_price, listing_id FROM order_items WHERE order_id = ANY($1)
              ${f.listingId ? 'AND listing_id = $2' : ''}`,
            f.listingId ? [rows.map((r) => r.id), f.listingId] : [rows.map((r) => r.id)],
          )
        ).rows
      : [];
    return { rows, items, total };
  }

  /** DIFAL cobrado nas faturas do ML por mês (AAAA-MM), das contas filtradas. */
  async billedDifal(db: Queryable, fromMonth: string, toMonth: string, accountId?: string) {
    const { rows } = await db.query<{ month: string; amount: string }>(
      `SELECT to_char(period_key, 'YYYY-MM') AS month, sum(difal) AS amount
         FROM ml_billing_periods
        WHERE period_key BETWEEN ($1 || '-01')::date AND ($2 || '-01')::date ${accountId ? 'AND account_id = $3' : ''}
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
