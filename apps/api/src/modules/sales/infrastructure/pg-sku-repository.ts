import type { SkuFilter, SkuRowDto } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { TIMEZONE } from '../domain/period.js';

/** Data mínima: o primeiro custo de um SKU vale para todo o histórico. */
export const SINCE_ALWAYS = '1900-01-01';
const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

/**
 * Custo vigente na data da venda (regra do NVS-WMS) aplicado aos itens, e totais dos pedidos
 * recalculados. Tudo escopado ao tenant pelo RLS.
 */
export class PgSkuRepository {
  async current(db: Queryable, sku: string) {
    const { rows } = await db.query<{ custo_unit: string }>('SELECT custo_unit FROM sku_costs WHERE sku = $1', [sku]);
    return rows[0] ? { custoUnit: Number(rows[0].custo_unit) } : null;
  }

  /** Última vigência do SKU e o dia (São Paulo) em que foi registrada. */
  async lastHistory(db: Queryable, sku: string): Promise<{ since: string; registeredOn: string } | null> {
    const { rows } = await db.query<{ since: string; registered_on: string }>(
      `SELECT to_char(vigente_desde, 'YYYY-MM-DD') AS since,
              to_char((registrado_em AT TIME ZONE '${TIMEZONE}')::date, 'YYYY-MM-DD') AS registered_on
         FROM sku_cost_history WHERE sku = $1 ORDER BY registrado_em DESC LIMIT 1`,
      [sku],
    );
    return rows[0] ? { since: rows[0].since, registeredOn: rows[0].registered_on } : null;
  }

  async upsert(db: Queryable, tenantId: string, userId: string, sku: string, custoUnit: number) {
    await db.query(
      `INSERT INTO sku_costs (tenant_id, sku, custo_unit, updated_by, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (tenant_id, sku) DO UPDATE
         SET custo_unit = EXCLUDED.custo_unit, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, sku, custoUnit, userId],
    );
  }

  async remove(db: Queryable, sku: string): Promise<boolean> {
    const { rowCount } = await db.query('DELETE FROM sku_costs WHERE sku = $1', [sku]);
    return (rowCount ?? 0) > 0;
  }

  async addHistory(
    db: Queryable,
    p: { tenantId: string; sku: string; custoUnit: number | null; since: string; origem: 'cadastro' | 'importacao' | 'removido'; userId: string },
  ) {
    await db.query(
      `INSERT INTO sku_cost_history (tenant_id, sku, custo_unit, vigente_desde, origem, registrado_por)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [p.tenantId, p.sku, p.custoUnit, p.since, p.origem, p.userId],
    );
  }

  // ---------- alíquota única de imposto (vale para todas as vendas)
  async currentTaxRate(db: Queryable): Promise<{ ratePct: number; since: string; registeredOn: string } | null> {
    const { rows } = await db.query<{ rate_pct: string; since: string; registered_on: string }>(
      `SELECT rate_pct, to_char(vigente_desde, 'YYYY-MM-DD') AS since,
              to_char((registrado_em AT TIME ZONE '${TIMEZONE}')::date, 'YYYY-MM-DD') AS registered_on
         FROM tax_rate_history ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 1`,
    );
    const r = rows[0];
    return r ? { ratePct: Number(r.rate_pct), since: r.since, registeredOn: r.registered_on } : null;
  }

  async addTaxRate(db: Queryable, tenantId: string, userId: string, ratePct: number, since: string): Promise<void> {
    await db.query(
      'INSERT INTO tax_rate_history (tenant_id, rate_pct, vigente_desde, registrado_por) VALUES ($1, $2, $3, $4)',
      [tenantId, ratePct, since, userId],
    );
  }

  /** Vigências que começam em `since` ou depois (substituídas por uma alíquota com data escolhida). */
  async dropTaxRatesFrom(db: Queryable, since: string): Promise<void> {
    await db.query('DELETE FROM tax_rate_history WHERE vigente_desde >= $1', [since]);
  }

  /**
   * Nova alíquota (a mais recente) nas vendas a partir de `since`. Só mexe no imposto, em UPDATEs diretos:
   * recalcular custo + imposto de todo o histórico numa transação estourou a memória do banco.
   */
  async applyTaxRate(db: Queryable, ratePct: number, since: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('apply-costs:' || current_setting('app.tenant_id', true)))");
    const fromSince = `o.ordered_at >= ($1::date::timestamp AT TIME ZONE '${TIMEZONE}')`;
    await db.query(
      `UPDATE order_items i SET tax_pct = $2 FROM orders o
        WHERE o.id = i.order_id AND ${fromSince} AND i.tax_pct IS DISTINCT FROM $2`,
      [since, ratePct],
    );
    // imposto (NVS-WMS) = (produto − cupom do vendedor) × alíquota
    await db.query(
      `UPDATE orders o SET tax_amount = round(greatest(o.gross_amount - o.coupon_seller, 0) * $2 / 100, 2)
        WHERE ${fromSince} AND o.source = 'marketplace'
          AND EXISTS (SELECT 1 FROM order_items i WHERE i.order_id = o.id)`,
      [since, ratePct],
    );
  }

  /**
   * Reaplica custo (vigente por SKU) e alíquota (vigente da empresa) na data de cada venda,
   * e recalcula os pedidos afetados. `all` = todas as vendas.
   */
  async applyCosts(db: Queryable, by: { skus?: string[]; orderIds?: string[]; all?: boolean }): Promise<number> {
    const where = by.all ? 'true' : by.skus ? 'i.sku = ANY($1)' : 'i.order_id = ANY($1)';
    const key = by.skus ?? by.orderIds ?? [];
    if (!by.all && !key.length) return 0;
    // recálculos da mesma empresa em fila (evita deadlock entre notificações/sincronização simultâneas)
    await db.query("SELECT pg_advisory_xact_lock(hashtext('apply-costs:' || current_setting('app.tenant_id', true)))");
    const saleDay = `(SELECT (o.ordered_at AT TIME ZONE '${TIMEZONE}')::date FROM orders o WHERE o.id = i.order_id)`;
    const { rows } = await db.query<{ order_id: string }>(
      `UPDATE order_items i SET
         unit_cost = (SELECT h.custo_unit FROM sku_cost_history h
                       WHERE h.sku = i.sku AND h.vigente_desde <= ${saleDay}
                       ORDER BY h.vigente_desde DESC, h.registrado_em DESC LIMIT 1),
         tax_pct = (SELECT t.rate_pct FROM tax_rate_history t
                     WHERE t.vigente_desde <= ${saleDay}
                     ORDER BY t.vigente_desde DESC, t.registrado_em DESC LIMIT 1)
        WHERE ${where}
       RETURNING i.order_id`,
      by.all ? [] : [key],
    );
    const orderIds = [...new Set(rows.map((r) => r.order_id))];
    if (orderIds.length) {
      await db.query(
        // imposto (NVS-WMS) = (produto − cupom do vendedor) × alíquota
        `UPDATE orders o SET product_cost = x.cost, cost_known = x.known,
                tax_amount = round(greatest(o.gross_amount - o.coupon_seller, 0) * coalesce(x.rate, 0) / 100, 2)
           FROM (SELECT order_id,
                        round(coalesce(sum(unit_cost * quantity), 0), 2) AS cost,
                        max(tax_pct) AS rate,
                        bool_and(unit_cost IS NOT NULL) AS known
                   FROM order_items WHERE order_id = ANY($1) GROUP BY order_id) x
          WHERE o.id = x.order_id AND o.source = 'marketplace'`,
        [orderIds],
      );
    }
    return orderIds.length;
  }

  /**
   * Lista consolidada: SKUs dos anúncios que existem hoje no marketplace (ativos, pausados, em revisão; com variações)
   * e os vendidos nos últimos 90 dias (ainda pesam na margem). Anúncio encerrado/excluído e venda antiga do histórico
   * não entram — o custo cadastrado deles continua guardado.
   */
  async list(db: Queryable, q: { q?: string; filter: SkuFilter; offset: number; limit: number }) {
    const base = `
      WITH all_skus AS (
        SELECT sku FROM listings WHERE sku IS NOT NULL AND status NOT IN ('closed', 'inactive')
        UNION SELECT unnest(variation_skus) FROM listings WHERE status NOT IN ('closed', 'inactive')
        UNION SELECT i.sku FROM order_items i JOIN orders o ON o.id = i.order_id
               WHERE o.ordered_at >= now() - interval '90 days'
      ),
      sold AS (
        SELECT i.sku, sum(i.quantity) AS units, sum(i.quantity * i.unit_price) / nullif(sum(i.quantity), 0) AS avg_price
          FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.status = 'paid' AND o.ordered_at >= now() - interval '30 days'
         GROUP BY i.sku
      ),
      seen AS (SELECT sku, max(title) AS title, max(listing_id) AS listing_id FROM order_items GROUP BY sku),
      -- mapa chave → melhor anúncio (ativo e mais recente), montado UMA vez: chave = SKU, SKU de variação ou MLB
      lmap AS (
        SELECT DISTINCT ON (k.key) k.key, l.title, l.picture_url, l.permalink, l.status, l.available_quantity
          FROM listings l
          CROSS JOIN LATERAL unnest(array_remove(ARRAY[l.sku, l.external_id] || l.variation_skus, NULL)) AS k(key)
         ORDER BY k.key, (l.status = 'active') DESC, l.updated_at DESC
      ),
      rows AS MATERIALIZED (
        SELECT s.sku, coalesce(l.title, seen.title) AS title, l.picture_url, l.permalink, l.status AS listing_status,
               l.available_quantity AS stock, coalesce(sold.units, 0) AS units30, sold.avg_price,
               c.custo_unit, c.updated_at
          FROM all_skus s
          LEFT JOIN sold ON sold.sku = s.sku
          LEFT JOIN seen ON seen.sku = s.sku
          LEFT JOIN sku_costs c ON c.sku = s.sku
          LEFT JOIN lmap direct ON direct.key = s.sku
          LEFT JOIN lmap via_sale ON via_sale.key = seen.listing_id
          CROSS JOIN LATERAL (SELECT coalesce(direct.title, via_sale.title) AS title, coalesce(direct.picture_url, via_sale.picture_url) AS picture_url,
                                     coalesce(direct.permalink, via_sale.permalink) AS permalink, coalesce(direct.status, via_sale.status) AS status,
                                     coalesce(direct.available_quantity, via_sale.available_quantity) AS available_quantity) l
         WHERE s.sku IS NOT NULL AND s.sku <> ''
      )`;
    const search = `($1::text IS NULL OR sku ILIKE '%' || $1 || '%' OR title ILIKE '%' || $1 || '%')`;
    const filter =
      q.filter === 'missing' ? 'custo_unit IS NULL' : q.filter === 'done' ? 'custo_unit IS NOT NULL' : 'true';
    // contadores e página na mesma consulta (a base é montada uma vez)
    const { rows } = await db.query(
      `${base}, found AS (SELECT * FROM rows WHERE ${search})
       SELECT p.*, c.all_n, c.done_n
         FROM (SELECT count(*) AS all_n, count(custo_unit) AS done_n FROM found) c
         LEFT JOIN LATERAL (
           SELECT * FROM found WHERE ${filter}
            ORDER BY (custo_unit IS NULL) DESC, units30 DESC, title NULLS LAST, sku
            LIMIT $2 OFFSET $3
         ) p ON true`,
      [q.q || null, q.limit, q.offset],
    );
    const all = Number(rows[0]?.all_n ?? 0);
    const done = Number(rows[0]?.done_n ?? 0);
    const page = rows.filter((r) => r.sku !== null);
    const items: SkuRowDto[] = page.map((r) => ({
      sku: r.sku,
      title: r.title,
      pictureUrl: r.picture_url,
      permalink: r.permalink,
      listingStatus: r.listing_status,
      stock: r.stock,
      units30d: Number(r.units30),
      avgPrice: num(r.avg_price),
      custoUnit: num(r.custo_unit),
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    }));
    const total = q.filter === 'missing' ? all - done : q.filter === 'done' ? done : all;
    return { items, total, counts: { all, done, missing: all - done } };
  }

  /** SKUs que existem no marketplace (anúncios e variações, mais o que já foi vendido): grafias exatas e MAIÚSCULO → grafia. */
  async knownSkus(db: Queryable): Promise<{ exact: Set<string>; byUpper: Map<string, string>; size: number }> {
    const { rows } = await db.query<{ sku: string }>(
      `SELECT DISTINCT trim(sku) AS sku FROM listings WHERE sku IS NOT NULL AND source = 'marketplace'
       UNION SELECT trim(v) FROM listings, unnest(variation_skus) v WHERE source = 'marketplace'
       UNION SELECT trim(i.sku) FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.source = 'marketplace'`,
    );
    const byUpper = new Map<string, string>();
    const exact = new Set<string>();
    for (const r of rows) {
      if (!r.sku) continue;
      exact.add(r.sku);
      if (!byUpper.has(r.sku.toUpperCase())) byUpper.set(r.sku.toUpperCase(), r.sku);
    }
    return { exact, byUpper, size: exact.size };
  }

  async allCosts(db: Queryable) {
    const { rows } = await db.query<{ sku: string; custo_unit: string }>('SELECT sku, custo_unit FROM sku_costs');
    return new Map(rows.map((r) => [r.sku, { custoUnit: Number(r.custo_unit) }]));
  }
}
