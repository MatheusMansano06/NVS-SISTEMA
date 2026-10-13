-- Preenche as médias de tarifa/frete por anúncio já no deploy (depois a sincronização mantém).
UPDATE listings l SET sales_fee_avg = x.fee, sales_freight_avg = x.freight
  FROM (
    SELECT l2.id,
           sum(o.marketplace_fee) / nullif(sum(o.units), 0) AS fee,
           sum(o.shipping_cost) / nullif(sum(o.units), 0) AS freight
      FROM listings l2
      JOIN order_items i ON i.listing_id = l2.external_id AND i.tenant_id = l2.tenant_id
      JOIN orders o ON o.id = i.order_id AND o.status = 'paid' AND o.finance_enriched_at IS NOT NULL
                   AND o.units = i.quantity AND o.ordered_at > now() - interval '90 days'
     GROUP BY l2.id
  ) x
 WHERE l.id = x.id;
