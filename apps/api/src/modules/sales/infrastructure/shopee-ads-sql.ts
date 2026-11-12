import { TIMEZONE } from '../domain/period.js';

/**
 * Shopee Ads no período ($1/$2 = dias de São Paulo, $3 = conta opcional), igual ao Mercado Ads: gasto real das
 * campanhas (Ads API). Enquanto a leitura do Ads não estiver liberada, usa a recarga de Ads descontada dos repasses
 * das vendas do período (que deixou de ser tarifa do pedido), para o custo não sumir.
 */
export const SHOPEE_AD_SPEND_SQL = `
  SELECT CASE
    WHEN EXISTS (SELECT 1 FROM shopee_connections c WHERE c.ads_synced_at IS NOT NULL AND ($3::uuid IS NULL OR c.account_id = $3))
    THEN (SELECT coalesce(sum(expense), 0) FROM shopee_ads_daily
           WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR account_id = $3))
    ELSE (SELECT coalesce(sum((e.tarifas->>'ads_fee')::numeric), 0)
            FROM shopee_escrows e
            JOIN orders o ON o.account_id = e.account_id AND o.marketplace = 'shopee' AND o.external_id = e.order_sn
           WHERE o.status = 'paid'
             AND o.ordered_at >= ($1::date)::timestamp AT TIME ZONE '${TIMEZONE}'
             AND o.ordered_at <  ($2::date + 1)::timestamp AT TIME ZONE '${TIMEZONE}'
             AND ($3::uuid IS NULL OR o.account_id = $3))
  END AS cost`;
