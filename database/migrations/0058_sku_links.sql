-- Vínculo de SKU entre plataformas: o mesmo produto às vezes tem SKU diferente em cada marketplace.
-- O SKU vinculado usa o custo (e o histórico de custo) do SKU de destino. Um nível só: destino não pode ser vínculo.
CREATE TABLE sku_links (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku        text NOT NULL,
  linked_sku text NOT NULL,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku),
  CHECK (sku <> linked_sku)
);
-- recalcular as vendas dos vinculados quando o custo do destino muda
CREATE INDEX sku_links_target_idx ON sku_links (tenant_id, linked_sku);

ALTER TABLE sku_links ENABLE ROW LEVEL SECURITY;
ALTER TABLE sku_links FORCE ROW LEVEL SECURITY;
CREATE POLICY sku_links_tenant_isolation ON sku_links
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
