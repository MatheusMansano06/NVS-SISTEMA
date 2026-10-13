-- Passo a passo inicial (onboarding) por usuário. Isolado por tenant via RLS.
CREATE TABLE onboarding_progress (
  user_id      uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  step         text NOT NULL DEFAULT 'welcome' CHECK (step IN ('welcome', 'platform', 'authorize', 'done')),
  marketplace  text CHECK (marketplace IN ('mercado_livre', 'shopee', 'tiktok_shop')),
  completed_at timestamptz,
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX onboarding_progress_tenant_idx ON onboarding_progress (tenant_id);

ALTER TABLE onboarding_progress ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_progress FORCE ROW LEVEL SECURITY;
CREATE POLICY onboarding_tenant_isolation ON onboarding_progress
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
