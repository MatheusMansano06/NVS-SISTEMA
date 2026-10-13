-- Análise financeira (regras do NVS-WMS) + alíquota única de imposto da empresa.

-- Alíquota de imposto sobre vendas: uma por empresa, com vigência (vale para todos os produtos).
CREATE TABLE tax_rate_history (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rate_pct       numeric(5, 2) NOT NULL CHECK (rate_pct BETWEEN 0 AND 100),
  vigente_desde  date NOT NULL,
  registrado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  registrado_em  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX tax_rate_history_lookup_idx ON tax_rate_history (tenant_id, vigente_desde DESC, registrado_em DESC);

-- Componentes financeiros do pedido (já rateados por pedido quando o envio é um pacote).
ALTER TABLE orders ADD COLUMN buyer_shipping numeric(14, 2) NOT NULL DEFAULT 0;   -- frete comprador (FC)
ALTER TABLE orders ADD COLUMN coupon_seller numeric(14, 2) NOT NULL DEFAULT 0;    -- cupom bancado pelo vendedor
ALTER TABLE orders ADD COLUMN refund_partial numeric(14, 2) NOT NULL DEFAULT 0;   -- devolução parcial
ALTER TABLE orders ADD COLUMN logistic_bucket text NOT NULL DEFAULT 'outros'
  CHECK (logistic_bucket IN ('full', 'flex', 'places_coleta', 'me1', 'outros'));
ALTER TABLE orders ADD COLUMN listing_type text;
ALTER TABLE orders ADD COLUMN freight_uncertain boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN finance_enriched_at timestamptz;
CREATE INDEX orders_tenant_shipping_ref_idx ON orders (tenant_id, shipping_ref);
CREATE INDEX orders_enrich_idx ON orders (tenant_id, account_id, ordered_at) WHERE finance_enriched_at IS NULL;

ALTER TABLE tax_rate_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE tax_rate_history FORCE ROW LEVEL SECURITY;
CREATE POLICY tax_rate_history_tenant_isolation ON tax_rate_history
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
