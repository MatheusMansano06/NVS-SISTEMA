-- Retenção: vendas com mais de 13 meses viram totais mensais (o detalhe venda a venda é apagado).
-- Granularidade: mês × conta × status × SKU × anúncio × estado × forma de pagamento × tipo de envio.
CREATE TABLE sales_monthly_totals (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  marketplace     text NOT NULL,
  month           date NOT NULL,                 -- 1º dia do mês (fuso de São Paulo)
  status          text NOT NULL,                 -- paid | cancelled | returned
  sku             text NOT NULL,
  listing_id      text NOT NULL DEFAULT '',
  ship_state      text NOT NULL DEFAULT '',
  payment_type    text NOT NULL DEFAULT '',
  logistic_bucket text NOT NULL DEFAULT '',
  source          text NOT NULL DEFAULT 'marketplace',
  orders          integer NOT NULL,
  units           integer NOT NULL,
  gross           numeric(16, 2) NOT NULL,       -- produto (itens)
  fee             numeric(16, 2) NOT NULL,       -- tarifa (rateada por item)
  shipping_cost   numeric(16, 2) NOT NULL,       -- frete pago pelo vendedor
  buyer_shipping  numeric(16, 2) NOT NULL,
  coupon          numeric(16, 2) NOT NULL,
  refund          numeric(16, 2) NOT NULL,
  tax             numeric(16, 2) NOT NULL,
  cost            numeric(16, 2) NOT NULL,       -- custo conhecido
  cost_known      boolean NOT NULL,              -- todos os itens tinham custo
  archived_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, month, status, sku, listing_id, ship_state, payment_type, logistic_bucket, source)
);
CREATE INDEX sales_monthly_totals_tenant_month_idx ON sales_monthly_totals (tenant_id, month);
ALTER TABLE sales_monthly_totals ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_monthly_totals FORCE ROW LEVEL SECURITY;
CREATE POLICY sales_monthly_totals_tenant_isolation ON sales_monthly_totals
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
