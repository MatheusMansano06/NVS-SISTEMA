-- Master Data do Full: produto (SKU + descrição) e seus códigos (wms_barcodes). Produto marcado como
-- "sem código físico" pode ser separado sem bipar (fica registrado como separação manual).
CREATE TABLE wms_products (
  tenant_id           uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku                 text NOT NULL,
  description         text,
  no_physical_barcode boolean NOT NULL DEFAULT false,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku)
);
ALTER TABLE wms_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_products FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_products_tenant_isolation ON wms_products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
CREATE INDEX wms_barcodes_code_idx ON wms_barcodes (tenant_id, barcode);
