-- Integração Shopee (Open Platform v2): conexão por loja (tokens criptografados), pedidos e escrow (repasse) por pedido.
-- O estado do OAuth e o roteamento loja → empresa reutilizam oauth_states e marketplace_identities (0005).
CREATE TABLE shopee_connections (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL UNIQUE REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  shop_id            text NOT NULL,
  access_token_enc   text NOT NULL,
  refresh_token_enc  text NOT NULL,
  -- o access token dura 4 horas; o refresh token, 30 dias (renovar de hora em hora mantém os dois vivos)
  expires_at         timestamptz NOT NULL,
  refresh_expires_at timestamptz,
  -- fim da autorização da loja (até 1 ano); depois disso o vendedor precisa autorizar de novo
  auth_expires_at    timestamptz,
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked', 'error')),
  last_error         text,
  sync_status        text NOT NULL DEFAULT 'idle' CHECK (sync_status IN ('idle', 'running', 'failed')),
  sync_error         text,
  orders_imported    integer NOT NULL DEFAULT 0,
  -- histórico completo já trazido (senão o agendador retoma de onde parou)
  backfilled         boolean NOT NULL DEFAULT false,
  -- até quando a lista de repasses (escrow liberado) já foi lida
  escrow_until       timestamptz,
  last_synced_at     timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, shop_id)
);

ALTER TABLE shopee_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee_connections FORCE ROW LEVEL SECURITY;
CREATE POLICY shopee_connections_tenant_isolation ON shopee_connections
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Escrow (repasse) de cada pedido, como a Shopee informa: estimado enquanto o pedido não foi liberado, definitivo depois.
-- Os valores do pedido em `orders` (produto, cupom, tarifa, fretes) saem daqui; o escrow bruto fica guardado para conferência.
CREATE TABLE shopee_escrows (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  order_sn           text NOT NULL,
  -- true = repasse liberado (escrow_list); false = estimativa da Shopee
  settled            boolean NOT NULL DEFAULT false,
  released_at        timestamptz,
  payout_amount      numeric(14,2),
  -- canônico NVS (mesma identidade do NVS W2: escrow = produto − cupom − tarifa líquida + frete comprador − frete vendedor)
  produto            numeric(14,2) NOT NULL DEFAULT 0,
  cupom              numeric(14,2) NOT NULL DEFAULT 0,
  tarifa             numeric(14,2) NOT NULL DEFAULT 0,
  tarifa_refund      numeric(14,2) NOT NULL DEFAULT 0,
  frete_comprador    numeric(14,2) NOT NULL DEFAULT 0,
  frete_vendedor     numeric(14,2) NOT NULL DEFAULT 0,
  escrow_amount      numeric(14,2) NOT NULL DEFAULT 0,
  -- o que a Shopee credita além dos componentes (rebates, subsídios, ajustes); positivo = crédito
  ajuste             numeric(14,2) NOT NULL DEFAULT 0,
  -- devolvido com reembolso ao comprador
  returned           boolean NOT NULL DEFAULT false,
  -- tarifas por tipo (comissão, serviço, transação, afiliados, Ads...)
  tarifas            jsonb NOT NULL DEFAULT '{}',
  quality_flags      text[] NOT NULL DEFAULT '{}',
  -- order_income original da Shopee (sem dados do comprador)
  income             jsonb NOT NULL DEFAULT '{}',
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, order_sn)
);

ALTER TABLE shopee_escrows ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee_escrows FORCE ROW LEVEL SECURITY;
CREATE POLICY shopee_escrows_tenant_isolation ON shopee_escrows
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Em teste: liberado só na empresa piloto (Novaes); fica fora do padrão de empresa e plano novos.
UPDATE tenants SET features = array_append(features, 'shopee'), features_custom = true
  WHERE cnpj = '06226411000186' AND NOT 'shopee' = ANY(features);
