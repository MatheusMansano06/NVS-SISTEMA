-- Última sincronização das devoluções por empresa (aparece na Central de Devoluções).
CREATE TABLE return_sync_state (
  tenant_id   uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  last_sync   timestamptz NOT NULL,
  last_result jsonb NOT NULL DEFAULT '{}'
);
ALTER TABLE return_sync_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_sync_state FORCE ROW LEVEL SECURITY;
CREATE POLICY return_sync_state_tenant_isolation ON return_sync_state
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
