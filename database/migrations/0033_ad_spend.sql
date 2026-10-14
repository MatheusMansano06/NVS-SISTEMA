-- Investimento em publicidade (Mercado Ads / Product Ads) por conta e dia, para o TACOS e a margem depois dos Ads.
-- O ML guarda as métricas de 90 dias para trás: a sincronização completa traz os 90 dias; a de hora em hora, os últimos.
CREATE TABLE ad_spend_daily (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  day         date NOT NULL,
  cost        numeric(14, 2) NOT NULL DEFAULT 0,
  fetched_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, day)
);

-- Situação da leitura de publicidade por conta (a tela avisa quando falta permissão ou a conta não anuncia)
CREATE TABLE ad_accounts (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  advertiser_id text,
  status        text NOT NULL CHECK (status IN ('ok', 'sem_anunciante', 'sem_permissao', 'erro')),
  error         text,
  checked_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_spend_daily', 'ad_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
