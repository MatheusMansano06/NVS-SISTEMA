import type { Queryable } from '../../../shared/infrastructure/database.js';
import { TIMEZONE, type DateRange } from '../domain/period.js';

export interface AbcListingRow {
  listing_id: string;
  title: string;
  picture_url: string | null;
  permalink: string | null;
  /** Faturamento em centavos (inteiro: os limites 80/95% são conferidos sem arredondamento). */
  revenue_cents: string;
  units: string;
}

export class PgAbcCurveRepository {
  /** Faturamento (quantidade × preço) e unidades de cada anúncio nas vendas pagas do período. Filtra a empresa além do RLS. */
  async byListing(db: Queryable, tenantId: string, range: DateRange): Promise<AbcListingRow[]> {
    const { rows } = await db.query<AbcListingRow>(
      `SELECT i.listing_id, coalesce(l.title, max(i.title)) AS title, l.picture_url, l.permalink,
              round(sum(i.quantity * i.unit_price) * 100)::bigint AS revenue_cents, sum(i.quantity)::bigint AS units
         FROM orders o
         JOIN order_items i ON i.order_id = o.id
         LEFT JOIN listings l ON l.tenant_id = o.tenant_id AND l.marketplace = o.marketplace AND l.external_id = i.listing_id
        WHERE o.tenant_id = $3 AND i.tenant_id = $3 AND o.status = 'paid' AND i.listing_id IS NOT NULL
          AND o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
          AND o.ordered_at < ($2::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
        GROUP BY i.listing_id, l.title, l.picture_url, l.permalink`,
      [range.from, range.to, tenantId],
    );
    return rows;
  }
}
