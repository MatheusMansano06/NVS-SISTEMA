-- Fotos de anúncios que aparecem nas devoluções mas não estão no catálogo sincronizado (anúncio finalizado, de outra
-- conta, antigo): buscadas uma vez no ML e guardadas. url NULL = anúncio sem foto (não busca de novo).
CREATE TABLE ml_item_pictures (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  item_id    text NOT NULL,
  url        text,
  sku        text,              -- SKU do anúncio (sem variação), para ligar o custo quando o pedido não traz
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, item_id)
);
ALTER TABLE ml_item_pictures ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_item_pictures FORCE ROW LEVEL SECURITY;
CREATE POLICY ml_item_pictures_tenant_isolation ON ml_item_pictures
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Faltas do picking: status (pendente/concluída) e quem/quando, como o Relatório de Faltas do NVS-WMS
ALTER TABLE wms_items ADD COLUMN shortage_status text NOT NULL DEFAULT 'pendente' CHECK (shortage_status IN ('pendente', 'concluido', 'removido'));
ALTER TABLE wms_items ADD COLUMN shortage_at timestamptz;
ALTER TABLE wms_items ADD COLUMN shortage_by uuid REFERENCES operators(id) ON DELETE SET NULL;
