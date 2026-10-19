-- Precificador › Viabilidade: pesquisas de produto (a planilha de viabilidade da mentoria), por empresa.
CREATE TABLE pricing_studies (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  title       text NOT NULL,
  link        text,
  supplier    text,
  notes       text,
  fee_pct     numeric(5, 2) NOT NULL DEFAULT 0,
  tax_pct     numeric(5, 2) NOT NULL DEFAULT 0,
  packaging   numeric(14, 2) NOT NULL DEFAULT 0,
  cost        numeric(14, 2),
  price       numeric(14, 2),
  height      numeric(8, 2),
  width       numeric(8, 2),
  length      numeric(8, 2),
  weight_kg   numeric(10, 3),
  target_pct  numeric(5, 2),
  margin      numeric(14, 2),
  margin_pct  numeric(9, 4),
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX pricing_studies_tenant_idx ON pricing_studies (tenant_id, updated_at DESC);
ALTER TABLE pricing_studies ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_studies FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_studies_tenant_isolation ON pricing_studies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
