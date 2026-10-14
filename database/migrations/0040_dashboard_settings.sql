-- Preferências do Dashboard da empresa: margem mínima do alerta de vendas com margem baixa (vale para todos os usuários).
CREATE TABLE dashboard_settings (
  tenant_id       uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  low_margin_pct  numeric(5, 2) NOT NULL DEFAULT 8,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE dashboard_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE dashboard_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY dashboard_settings_tenant_isolation ON dashboard_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
