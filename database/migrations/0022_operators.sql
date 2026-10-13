-- Operação (expedição): operadores da empresa que entram por nome + PIN de 4 dígitos num computador
-- da operação. O PIN padrão é 1234 e precisa ser trocado no primeiro acesso.
CREATE TABLE operators (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name            text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  pin_hash        text NOT NULL,
  must_change_pin boolean NOT NULL DEFAULT true,
  is_active       boolean NOT NULL DEFAULT true,
  failed_attempts integer NOT NULL DEFAULT 0,
  locked_until    timestamptz,
  last_login_at   timestamptz,
  created_by      uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX operators_tenant_name_idx ON operators (tenant_id, lower(name)) WHERE is_active;
ALTER TABLE operators ENABLE ROW LEVEL SECURITY;
ALTER TABLE operators FORCE ROW LEVEL SECURITY;
CREATE POLICY operators_tenant_isolation ON operators
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
