-- Supervisão Full: formato da etiqueta da empresa. As etiquetas saem em PDF no tamanho da etiqueta e são impressas
-- pelo navegador em qualquer impressora (rolo de 1 ou 2 colunas, ou folha A4). Sem agente local nem ERP.
CREATE TABLE wms_settings (
  tenant_id        uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  label_format     text NOT NULL DEFAULT 'rolo_1col' CHECK (label_format IN ('rolo_1col', 'rolo_2col', 'a4')),
  label_width_mm   numeric(5, 1) NOT NULL DEFAULT 50 CHECK (label_width_mm BETWEEN 20 AND 120),
  label_height_mm  numeric(5, 1) NOT NULL DEFAULT 25 CHECK (label_height_mm BETWEEN 15 AND 80),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- quem usava o agente Zebra fica com o mesmo formato do ZPL de antes (rolo de 2 colunas de 40 × 25 mm)
INSERT INTO wms_settings (tenant_id, label_format, label_width_mm, label_height_mm)
SELECT DISTINCT tenant_id, 'rolo_2col', 40, 25 FROM wms_print_agent_keys
ON CONFLICT DO NOTHING;

-- (RLS depois da carga inicial: a migration não tem app.tenant_id)
ALTER TABLE wms_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_settings_tenant_isolation ON wms_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
