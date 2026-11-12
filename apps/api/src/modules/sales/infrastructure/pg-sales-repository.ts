import type { Marketplace, PausedListing, SeriesPoint, TopProduct } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { TIMEZONE, type DateRange } from '../domain/period.js';
import type { KpiTotals } from '../domain/kpis.js';
import { SHOPEE_AD_SPEND_SQL } from './shopee-ads-sql.js';

export interface SalesFilter {
  range: DateRange;
  marketplace?: Marketplace;
  accountId?: string;
}

/**
 * Parâmetros comuns: $1/$2 = datas locais (inclusivas), convertidas para o instante
 * exato em São Paulo; $3/$4 = filtros opcionais. O tenant é garantido pelo RLS.
 */
const WHERE = `o.status = 'paid'
  AND o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
  AND o.ordered_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
  AND ($3::text IS NULL OR o.marketplace = $3)
  AND ($4::uuid IS NULL OR o.account_id = $4)`;

// sem filtro = Mercado Livre: os outros marketplaces (TikTok Shop) só aparecem quando pedidos, nunca misturados
const params = (f: SalesFilter) => [f.range.from, f.range.to, f.marketplace ?? 'mercado_livre', f.accountId ?? null];
const num = (v: unknown) => Number(v ?? 0);

export class PgSalesRepository {
  async totals(db: Queryable, f: SalesFilter): Promise<KpiTotals> {
    const { rows } = await db.query(
      `SELECT count(*) AS orders,
              coalesce(sum(o.units), 0) AS units,
              coalesce(sum(o.gross_amount), 0) AS revenue,
              coalesce(sum(o.marketplace_fee + o.shipping_cost), 0) AS fees,
              coalesce(sum(o.product_cost), 0) AS cost,
              coalesce(sum(o.tax_amount), 0) AS tax
         FROM orders o WHERE ${WHERE}`,
      params(f),
    );
    const r = rows[0] ?? {};
    return { orders: num(r.orders), units: num(r.units), revenue: num(r.revenue), fees: num(r.fees), cost: num(r.cost), tax: num(r.tax) };
  }

  /**
   * Investido em anúncios no período (respeita o filtro de conta), igual à Análise Financeira. Mercado Livre: Mercado
   * Ads. TikTok Shop: anúncios descontados das vendas (ajustes "GMV payment for TikTok Ads" do extrato). Shopee: Shopee Ads.
   */
  async adSpend(db: Queryable, f: SalesFilter): Promise<number> {
    if (f.marketplace === 'tiktok_shop') {
      const { rows } = await db.query(
        `SELECT coalesce(sum(-adjustment), 0) AS cost FROM tiktok_statement_transactions
          WHERE type = 'GMV_PAYMENT_FOR_TIKTOK_ADS'
            AND (statement_time AT TIME ZONE 'UTC')::date BETWEEN $1::date AND $2::date
            AND ($3::uuid IS NULL OR account_id = $3)`,
        [f.range.from, f.range.to, f.accountId ?? null],
      );
      return Math.max(0, num(rows[0]?.cost));
    }
    if (f.marketplace === 'shopee') {
      const { rows } = await db.query(SHOPEE_AD_SPEND_SQL, [f.range.from, f.range.to, f.accountId ?? null]);
      return Math.max(0, num(rows[0]?.cost));
    }
    if (f.marketplace && f.marketplace !== 'mercado_livre') return 0;
    const { rows } = await db.query(
      `SELECT coalesce(sum(cost), 0) AS cost FROM ad_spend_daily
        WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR account_id = $3)`,
      [f.range.from, f.range.to, f.accountId ?? null],
    );
    return num(rows[0]?.cost);
  }

  /** Situação do Mercado Ads nas contas do filtro: a pior manda (falta de permissão aparece). */
  async adsInfo(db: Queryable, accountId?: string) {
    const { rows } = await db.query<{ status: string; error: string | null }>(
      `SELECT status, error FROM ad_accounts WHERE ($1::uuid IS NULL OR account_id = $1)`,
      [accountId ?? null],
    );
    return rows;
  }

  /**
   * Ciclo da fatura do ML mais recente (e o anterior DA MESMA conta), das faturas já lidas. Com várias contas e sem
   * filtro, vale a conta de ciclo mais recente: misturar contas sobrepunha o "anterior" ao atual.
   */
  async invoicePeriods(db: Queryable, today: string, accountId?: string) {
    const { rows } = await db.query<{ from: string; to: string }>(
      `WITH cur AS (
         SELECT account_id, date_from, date_to FROM ml_billing_periods
          WHERE date_from IS NOT NULL AND date_to IS NOT NULL AND date_from <= $1::date
            AND ($2::uuid IS NULL OR account_id = $2)
          ORDER BY date_from DESC, account_id LIMIT 1
       ),
       prev AS (
         SELECT p.date_from, p.date_to FROM ml_billing_periods p JOIN cur ON p.account_id = cur.account_id
          WHERE p.date_from IS NOT NULL AND p.date_to IS NOT NULL AND p.date_to < cur.date_from
          ORDER BY p.date_from DESC LIMIT 1
       )
       SELECT to_char(date_from, 'YYYY-MM-DD') AS from, to_char(date_to, 'YYYY-MM-DD') AS to, 0 AS ord FROM cur
       UNION ALL
       SELECT to_char(date_from, 'YYYY-MM-DD'), to_char(date_to, 'YYYY-MM-DD'), 1 FROM prev
       ORDER BY ord`,
      [today, accountId ?? null],
    );
    return rows.map(({ from, to }) => ({ from, to }));
  }

  /** Série completa (intervalos sem venda vêm zerados) por hora ou por dia. */
  async series(db: Queryable, f: SalesFilter, granularity: 'hour' | 'day'): Promise<SeriesPoint[]> {
    const { rows } = await db.query(
      `WITH buckets AS (
         SELECT generate_series(
           ($1::date)::timestamp,
           CASE WHEN $5 = 'hour' THEN ($2::date)::timestamp + interval '23 hours' ELSE ($2::date)::timestamp END,
           CASE WHEN $5 = 'hour' THEN interval '1 hour' ELSE interval '1 day' END
         ) AS bucket
       ),
       agg AS (
         SELECT date_trunc($5, o.ordered_at AT TIME ZONE '${TIMEZONE}') AS bucket,
                sum(o.gross_amount) AS revenue,
                sum(o.gross_amount - o.marketplace_fee - o.shipping_cost - o.product_cost - o.tax_amount) AS profit
           FROM orders o WHERE ${WHERE}
          GROUP BY 1
       )
       SELECT to_char(b.bucket, 'YYYY-MM-DD"T"HH24:MI:SS') AS bucket,
              coalesce(a.revenue, 0) AS revenue, coalesce(a.profit, 0) AS profit
         FROM buckets b LEFT JOIN agg a USING (bucket)
        ORDER BY b.bucket`,
      [...params(f), granularity],
    );
    return rows.map((r) => ({ bucket: r.bucket, revenue: num(r.revenue), profit: num(r.profit) }));
  }

  /** Top produtos; tarifas e frete do pedido são rateados pelo valor de cada item. */
  async topProducts(db: Queryable, f: SalesFilter, totalRevenue: number, limit = 5): Promise<TopProduct[]> {
    const { rows } = await db.query(
      `SELECT i.sku, max(i.title) AS title,
              coalesce(max(l.picture_url), max(i.picture_url)) AS picture_url, max(l.permalink) AS permalink,
              sum(i.quantity) AS units,
              sum(i.quantity * i.unit_price) AS revenue,
              sum(i.quantity * coalesce(i.unit_cost, 0)) AS cost,
              sum(i.quantity * i.unit_price
                  * (1 - (o.marketplace_fee + o.shipping_cost) / nullif(o.gross_amount, 0)
                       - coalesce(i.tax_pct, 0) / 100)
                  - i.quantity * coalesce(i.unit_cost, 0)) AS profit
         FROM order_items i JOIN orders o ON o.id = i.order_id
         LEFT JOIN listings l ON l.tenant_id = i.tenant_id AND l.marketplace = o.marketplace AND l.external_id = i.listing_id
        WHERE ${WHERE}
        GROUP BY i.sku
        ORDER BY revenue DESC
        LIMIT $5`,
      [...params(f), limit],
    );
    return rows.map((r) => {
      const units = num(r.units);
      const revenue = num(r.revenue);
      const profit = num(r.profit);
      return {
        sku: r.sku,
        title: r.title,
        pictureUrl: r.picture_url ?? null,
        permalink: r.permalink ?? null,
        units,
        avgPrice: units ? revenue / units : 0,
        avgCost: units ? num(r.cost) / units : 0,
        revenue,
        share: totalRevenue > 0 ? revenue / totalRevenue : 0,
        profit,
        margin: revenue > 0 ? profit / revenue : 0,
      };
    });
  }

  /** Pausados (sem estoque primeiro), respeitando filtros de marketplace/conta. */
  async paused(db: Queryable, f: Omit<SalesFilter, 'range'>, limit = 30) {
    if (f.marketplace === 'tiktok_shop') return this.pausedTiktok(db, f.accountId, limit);
    if (f.marketplace === 'shopee') return this.pausedShopee(db, f.accountId, limit);
    // sem filtro = Mercado Livre (marketplaces nunca misturados)
    const params = [f.marketplace ?? 'mercado_livre', f.accountId ?? null];
    const where = `l.status = 'paused' AND ($1::text IS NULL OR l.marketplace = $1) AND ($2::uuid IS NULL OR l.account_id = $2)`;
    const oos = `(coalesce(l.available_quantity, 0) = 0 OR 'out_of_stock' = ANY(l.sub_status))`;
    const counts = await db.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ${oos}) AS oos FROM listings l WHERE ${where}`,
      params,
    );
    const { rows } = await db.query(
      `SELECT l.external_id, l.title, l.picture_url, l.permalink, l.price, l.available_quantity,
              ${oos} AS out_of_stock, a.nickname
         FROM listings l JOIN marketplace_accounts a ON a.id = l.account_id
        WHERE ${where}
        ORDER BY ${oos} DESC, l.updated_at DESC
        LIMIT $3`,
      [...params, limit],
    );
    const items: PausedListing[] = rows.map((r) => ({
      id: r.external_id,
      title: r.title,
      pictureUrl: r.picture_url,
      permalink: r.permalink,
      price: r.price === null ? null : num(r.price),
      availableQuantity: r.available_quantity,
      outOfStock: r.out_of_stock,
      accountNickname: r.nickname,
    }));
    return { total: num(counts.rows[0]?.total), outOfStock: num(counts.rows[0]?.oos), items };
  }

  /**
   * Produtos desativados no TikTok Shop (pelo vendedor, pela plataforma ou congelados), sem estoque primeiro.
   * Ficam em `tiktok_products`, fora de `listings`, para não entrarem nas telas que são só do Mercado Livre.
   * A busca de produtos do TikTok não traz foto: usa a da variação vendida no pedido, quando houver.
   */
  private async pausedTiktok(db: Queryable, accountId: string | undefined, limit: number) {
    const where = `p.status = ANY('{SELLER_DEACTIVATED,PLATFORM_DEACTIVATED,FREEZE}') AND ($1::uuid IS NULL OR p.account_id = $1)`;
    const oos = 'coalesce(p.available_quantity, 0) = 0';
    const counts = await db.query(
      `SELECT count(*) AS total, count(*) FILTER (WHERE ${oos}) AS oos FROM tiktok_products p WHERE ${where}`,
      [accountId ?? null],
    );
    const { rows } = await db.query(
      `SELECT p.product_id, p.title, p.price, p.available_quantity, ${oos} AS out_of_stock, a.nickname,
              coalesce(p.picture_url, (SELECT i.picture_url FROM order_items i
                                        WHERE i.tenant_id = p.tenant_id AND i.listing_id = p.product_id AND i.picture_url IS NOT NULL
                                        LIMIT 1)) AS picture_url
         FROM tiktok_products p JOIN marketplace_accounts a ON a.id = p.account_id
        WHERE ${where}
        ORDER BY ${oos} DESC, p.updated_at DESC
        LIMIT $2`,
      [accountId ?? null, limit],
    );
    const items: PausedListing[] = rows.map((r) => ({
      id: r.product_id,
      title: r.title,
      pictureUrl: r.picture_url,
      permalink: null,
      price: r.price === null ? null : num(r.price),
      availableQuantity: r.available_quantity,
      outOfStock: r.out_of_stock,
      accountNickname: r.nickname,
    }));
    return { total: num(counts.rows[0]?.total), outOfStock: num(counts.rows[0]?.oos), items };
  }

  /** Anúncios da Shopee fora do ar (deslistados ou bloqueados), sem estoque primeiro. Tabela própria, fora de `listings`. */
  private async pausedShopee(db: Queryable, accountId: string | undefined, limit: number) {
    const where = '($1::uuid IS NULL OR p.account_id = $1)';
    const oos = 'coalesce(p.available_quantity, 0) = 0';
    const counts = await db.query(`SELECT count(*) AS total, count(*) FILTER (WHERE ${oos}) AS oos FROM shopee_products p WHERE ${where}`, [accountId ?? null]);
    const { rows } = await db.query(
      `SELECT p.item_id, p.title, p.price, p.available_quantity, p.picture_url, ${oos} AS out_of_stock, a.nickname
         FROM shopee_products p JOIN marketplace_accounts a ON a.id = p.account_id
        WHERE ${where}
        ORDER BY ${oos} DESC, p.updated_at DESC
        LIMIT $2`,
      [accountId ?? null, limit],
    );
    const items: PausedListing[] = rows.map((r) => ({
      id: r.item_id,
      title: r.title,
      pictureUrl: r.picture_url,
      permalink: null,
      price: r.price === null ? null : num(r.price),
      availableQuantity: r.available_quantity,
      outOfStock: r.out_of_stock,
      accountNickname: r.nickname,
    }));
    return { total: num(counts.rows[0]?.total), outOfStock: num(counts.rows[0]?.oos), items };
  }

  /** Leitura do Shopee Ads recusada nas contas do filtro (motivo), se houver. */
  async shopeeAdsError(db: Queryable, accountId?: string): Promise<string | null> {
    const { rows } = await db.query<{ ads_error: string | null }>(
      'SELECT ads_error FROM shopee_connections WHERE ads_error IS NOT NULL AND ($1::uuid IS NULL OR account_id = $1) LIMIT 1',
      [accountId ?? null],
    );
    return rows[0]?.ads_error ?? null;
  }

  /** Contas de todos os marketplaces (a tela mostra as do marketplace escolhido). */
  async accounts(db: Queryable) {
    const { rows } = await db.query<{ id: string; marketplace: Marketplace; nickname: string }>(
      "SELECT id, marketplace, nickname FROM marketplace_accounts WHERE marketplace IN ('mercado_livre', 'tiktok_shop', 'shopee') ORDER BY nickname",
    );
    return rows;
  }

  /** Há venda paga no período/filtro sem custo cadastrado (lucro e margem incompletos)? */
  async hasMissingCosts(db: Queryable, f: SalesFilter): Promise<boolean> {
    const { rows } = await db.query(
      `SELECT EXISTS (SELECT 1 FROM orders o WHERE ${WHERE} AND o.source = 'marketplace' AND NOT o.cost_known) AS missing`,
      params(f),
    );
    return Boolean(rows[0]?.missing);
  }

  async hasDemoData(db: Queryable): Promise<boolean> {
    const { rows } = await db.query("SELECT EXISTS (SELECT 1 FROM orders WHERE source = 'demo') AS demo");
    return Boolean(rows[0]?.demo);
  }
}
