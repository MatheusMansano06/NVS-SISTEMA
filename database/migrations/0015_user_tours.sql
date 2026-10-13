-- Tours guiados da Gertrudez: o que cada usuário já viu (concluiu ou pulou), por tela.
CREATE TABLE user_tours (
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  tour_id    text NOT NULL CHECK (tour_id ~ '^[a-z0-9-]{2,40}$'),
  status     text NOT NULL CHECK (status IN ('done', 'skipped')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, tour_id)
);
ALTER TABLE user_tours ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_tours FORCE ROW LEVEL SECURITY;
CREATE POLICY user_tours_tenant_isolation ON user_tours
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
