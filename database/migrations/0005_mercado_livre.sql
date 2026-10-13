-- Integração Mercado Livre: OAuth, conexões (tokens criptografados) e sincronização progressiva.

-- Estados OAuth de uso único (valor aleatório imprevisível). Sem RLS: o callback chega
-- do Mercado Livre e só conhece o `state`.
CREATE TABLE oauth_states (
  state         text PRIMARY KEY,
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_verifier text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Roteia notificações (que só trazem o user_id do vendedor) para a empresa certa.
-- Uma conta do marketplace pertence a uma única empresa.
CREATE TABLE marketplace_identities (
  marketplace      text NOT NULL,
  external_user_id text NOT NULL,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  PRIMARY KEY (marketplace, external_user_id)
);

CREATE TABLE ml_connections (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL UNIQUE REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  ml_user_id        bigint NOT NULL,
  access_token_enc  text NOT NULL,
  refresh_token_enc text NOT NULL,
  expires_at        timestamptz NOT NULL,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, ml_user_id)
);

CREATE TABLE ml_sync_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connection_id   uuid NOT NULL REFERENCES ml_connections(id) ON DELETE CASCADE,
  status          text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  phase           text NOT NULL DEFAULT 'profile',
  progress        integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  orders_imported integer NOT NULL DEFAULT 0,
  error           text,
  started_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE INDEX ml_sync_runs_connection_idx ON ml_sync_runs (connection_id, started_at DESC);

-- referência do envio, para buscar o custo de frete pago pelo vendedor
ALTER TABLE orders ADD COLUMN shipping_ref text;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ml_connections', 'ml_sync_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
