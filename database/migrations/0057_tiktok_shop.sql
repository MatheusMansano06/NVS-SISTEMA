-- Integração TikTok Shop: conexão por loja (tokens criptografados) e sincronização dos pedidos.
-- O estado do OAuth e o roteamento loja → empresa reutilizam oauth_states e marketplace_identities (0005).
CREATE TABLE tiktok_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL UNIQUE REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  shop_id            text NOT NULL,
  -- identificador da loja exigido em toda chamada da API (não é segredo)
  shop_cipher        text NOT NULL,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  expires_at         timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error         text,
  sync_status        text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'running', 'failed')),
  sync_error         text,
  orders_imported    integer NOT NULL DEFAULT 0,
  -- histórico completo já trazido (senão o agendador retoma de onde parou)
  backfilled         boolean NOT NULL DEFAULT false,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shop_id)
);

ALTER TABLE tiktok_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY tiktok_connections_tenant_isolation ON tiktok_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Em teste: liberado só na empresa piloto (Novaes); fica fora do padrão de empresa e plano novos.
UPDATE tenants SET features = array_append(features, 'tiktok_shop'), features_custom = true
  WHERE cnpj = '06226411000186' AND NOT 'tiktok_shop' = ANY(features);
