-- Radar de Frete: uma leitura por dia do frete que o ML cobra do vendedor em cada anúncio com frete grátis.
CREATE TABLE listing_freight_history (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id text NOT NULL,
  day        date NOT NULL,
  list_cost  numeric(14, 2) NOT NULL,
  PRIMARY KEY (tenant_id, listing_id, day)
);
CREATE INDEX listing_freight_history_day_idx ON listing_freight_history (tenant_id, day DESC);
ALTER TABLE listing_freight_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_freight_history FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_freight_history_tenant_isolation ON listing_freight_history
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
