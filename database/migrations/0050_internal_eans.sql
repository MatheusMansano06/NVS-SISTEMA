-- Gerador de EAN interno: códigos de circulação restrita da GS1 (20 + sequência + verificador), no máximo um por SKU.
-- O contador por empresa só avança: um número apagado nunca volta a ser usado para outro produto.
CREATE TABLE internal_ean_counters (
  tenant_id uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_seq  bigint NOT NULL DEFAULT 0
);
ALTER TABLE internal_ean_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_ean_counters FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_ean_counters_tenant_isolation ON internal_ean_counters
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

CREATE TABLE internal_eans (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code        text NOT NULL CHECK (code ~ '^2[0-9]{12}$'),
  sku         text,                       -- null = código "livre", associado a um SKU depois
  description text,
  gtin        text,                       -- GTIN oficial (GS1) quando a empresa registrar o produto
  created_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, code),
  UNIQUE (tenant_id, sku)
);
CREATE INDEX internal_eans_created_idx ON internal_eans (tenant_id, created_at DESC);
ALTER TABLE internal_eans ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_eans FORCE ROW LEVEL SECURITY;
CREATE POLICY internal_eans_tenant_isolation ON internal_eans
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
