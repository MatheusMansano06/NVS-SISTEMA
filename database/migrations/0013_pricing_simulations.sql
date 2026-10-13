-- Precificador: simulações salvas (por empresa) para comparar e decidir depois.
CREATE TABLE pricing_simulations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  listing_id   text,                       -- vazio = simulação livre
  title        text NOT NULL,
  sku          text,
  listing_type text NOT NULL CHECK (listing_type IN ('gold_special', 'gold_pro')),
  price        numeric(14, 2) NOT NULL CHECK (price > 0),
  cost         numeric(14, 2),
  freight      numeric(14, 2) NOT NULL DEFAULT 0,
  tax_pct      numeric(5, 2) NOT NULL DEFAULT 0,
  fee          numeric(14, 2) NOT NULL,
  margin       numeric(14, 2),
  margin_pct   numeric(7, 4),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_simulations_tenant_idx ON pricing_simulations (tenant_id, created_at DESC);
ALTER TABLE pricing_simulations ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_simulations FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_simulations_tenant_isolation ON pricing_simulations
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
