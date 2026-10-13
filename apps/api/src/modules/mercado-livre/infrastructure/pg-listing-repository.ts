import type { ListingTab } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';

export interface ListingRow {
  external_id: string;
  account_id: string;
  account_nickname: string;
  title: string;
  sku: string | null;
  picture_url: string | null;
  permalink: string | null;
  status: string;
  sub_status: string[];
  price: string | null;
  available_quantity: number | null;
  sold_quantity: number | null;
  listing_type_id: string | null;
  free_shipping: boolean;
  logistic_type: string | null;
  catalog_listing: boolean;
  category_id: string | null;
  pictures_count: number | null;
  dimensions: string | null;
  listed_at: Date | null;
  custo_unit: string | null;
  avg_fee: string | null;
  avg_freight: string | null;
  fee_amount: string | null;
  fee_pct: string | null;
  freight_cost: string | null;
  pricing_price: string | null;
  pricing_at: Date | null;
}

/** Colunas da aba + tarifa/frete médios por unidade (pedidos de 1 item deste anúncio, 90 dias). */
const SELECT = `
  SELECT l.external_id, l.account_id, a.nickname AS account_nickname, l.title, l.sku, l.picture_url, l.permalink,
         l.status, l.sub_status, l.price, l.available_quantity, l.sold_quantity, l.listing_type_id,
         l.free_shipping, l.logistic_type, l.catalog_listing, l.category_id, l.pictures_count,
         l.dimensions, l.listed_at, sc.custo_unit, h.avg_fee, h.avg_freight,
         l.fee_amount, l.fee_pct, l.freight_cost, l.pricing_price, l.pricing_at
    FROM listings l
    JOIN marketplace_accounts a ON a.id = l.account_id
    LEFT JOIN sku_costs sc ON sc.sku = l.sku
    LEFT JOIN LATERAL (
      SELECT sum(o.marketplace_fee) / nullif(sum(o.units), 0) AS avg_fee,
             sum(o.shipping_cost) / nullif(sum(o.units), 0) AS avg_freight
        FROM order_items i JOIN orders o ON o.id = i.order_id
       WHERE i.listing_id = l.external_id AND o.status = 'paid' AND o.finance_enriched_at IS NOT NULL
         AND o.units = i.quantity AND o.ordered_at > now() - interval '90 days'
    ) h ON true`;

const num = (v: string | null) => (v === null ? null : Number(v));
export { num as toNumber };

/** Anúncios do catálogo local (sincronizado do marketplace). Escopado ao tenant pelo RLS. */
export class PgListingRepository {
  async list(db: Queryable, q: { status: ListingTab; q?: string; offset: number; limit: number }) {
    const params: unknown[] = [q.status];
    let search = '';
    if (q.q) {
      params.push(`%${q.q.replace(/[\\%_]/g, '\\$&')}%`);
      search = `AND (l.title ILIKE $2 OR l.sku ILIKE $2 OR l.external_id ILIKE $2 OR $2 ILIKE '%' || l.external_id || '%'
                  OR EXISTS (SELECT 1 FROM unnest(l.variation_skus) v WHERE v ILIKE $2))`;
    }
    const filter = `l.status = $1 AND l.marketplace = 'mercado_livre' ${search}`;
    const total = await db.query<{ n: string }>(`SELECT count(*) AS n FROM listings l WHERE ${filter}`, params);
    params.push(q.limit, q.offset);
    const { rows } = await db.query<ListingRow>(
      `${SELECT}
        WHERE ${filter}
        ORDER BY l.sold_quantity DESC NULLS LAST, l.title
        LIMIT $${params.length - 1} OFFSET $${params.length}`,
      params,
    );
    return { rows, total: Number(total.rows[0]!.n) };
  }

  async counts(db: Queryable): Promise<Record<ListingTab, number>> {
    const { rows } = await db.query<{ status: string; n: string }>(
      `SELECT status, count(*) AS n FROM listings WHERE marketplace = 'mercado_livre' GROUP BY status`,
    );
    const out: Record<ListingTab, number> = { active: 0, paused: 0, closed: 0 };
    for (const r of rows) if (r.status in out) out[r.status as ListingTab] = Number(r.n);
    return out;
  }

  async one(db: Queryable, externalId: string) {
    return (await this.byIds(db, [externalId]))[0] ?? null;
  }

  async byIds(db: Queryable, externalIds: string[]): Promise<ListingRow[]> {
    if (!externalIds.length) return [];
    const { rows } = await db.query<ListingRow>(
      `${SELECT} WHERE l.external_id = ANY($1) AND l.marketplace = 'mercado_livre'`,
      [externalIds],
    );
    return rows;
  }

  async taxPct(db: Queryable): Promise<number> {
    const { rows } = await db.query<{ rate_pct: string }>(
      'SELECT rate_pct FROM tax_rate_history ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 1',
    );
    return rows[0] ? Number(rows[0].rate_pct) : 0;
  }

  async sales(db: Queryable, externalId: string, offset: number, limit: number) {
    const { rows } = await db.query<{
      order_id: string; ordered_at: Date; status: 'paid' | 'cancelled' | 'returned'; quantity: number; unit_price: string;
    }>(
      `SELECT o.external_id AS order_id, o.ordered_at, o.status, i.quantity, i.unit_price
         FROM order_items i JOIN orders o ON o.id = i.order_id
        WHERE i.listing_id = $1 ORDER BY o.ordered_at DESC LIMIT $2 OFFSET $3`,
      [externalId, limit, offset],
    );
    const t = await db.query<{ orders: string; units: string; gross: string; total: string }>(
      `SELECT count(*) FILTER (WHERE o.status = 'paid') AS orders,
              coalesce(sum(i.quantity) FILTER (WHERE o.status = 'paid'), 0) AS units,
              coalesce(sum(i.quantity * i.unit_price) FILTER (WHERE o.status = 'paid'), 0) AS gross,
              count(*) AS total
         FROM order_items i JOIN orders o ON o.id = i.order_id WHERE i.listing_id = $1`,
      [externalId],
    );
    return { rows, totals: t.rows[0]! };
  }

  async savePricing(
    db: Queryable,
    externalId: string,
    p: { price: number; fee: number | null; feePct: number | null; freight: number | null },
  ) {
    await db.query(
      `UPDATE listings SET fee_amount = $2, fee_pct = $3, freight_cost = $4, pricing_price = $5, pricing_at = now()
        WHERE external_id = $1 AND marketplace = 'mercado_livre'`,
      [externalId, p.fee, p.feePct, p.freight, p.price],
    );
  }

  async setLocal(db: Queryable, externalId: string, f: { price?: number; stock?: number; status?: string }) {
    await db.query(
      `UPDATE listings SET price = coalesce($2, price), available_quantity = coalesce($3, available_quantity),
              status = coalesce($4, status), updated_at = now()
        WHERE external_id = $1 AND marketplace = 'mercado_livre'`,
      [externalId, f.price ?? null, f.stock ?? null, f.status ?? null],
    );
  }
}
