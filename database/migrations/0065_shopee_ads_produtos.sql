-- Shopee Ads: gasto diário das campanhas (Ads API), como o Mercado Ads, para o Dashboard e a Análise Financeira.
-- A recarga de Ads descontada do repasse (ads_escrow_top_up_fee) deixa de ser tarifa do pedido: é dinheiro indo para
-- a carteira de anúncios; o custo de Ads entra uma vez só, pelo gasto real das campanhas.
CREATE TABLE shopee_ads_daily (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  day          date NOT NULL,
  expense      numeric(14,2) NOT NULL DEFAULT 0,
  -- vendas atribuídas aos anúncios (broad GMV) e alcance
  gmv          numeric(14,2) NOT NULL DEFAULT 0,
  clicks       integer NOT NULL DEFAULT 0,
  impressions  integer NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, day)
);
ALTER TABLE shopee_ads_daily ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee_ads_daily FORCE ROW LEVEL SECURITY;
CREATE POLICY shopee_ads_daily_tenant_isolation ON shopee_ads_daily
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- leitura do Shopee Ads: null = ok (ou ainda não lida); texto = motivo (ex.: app sem a permissão de Ads)
ALTER TABLE shopee_connections ADD COLUMN ads_error text, ADD COLUMN ads_synced_at timestamptz;

-- Shopee: anúncios fora do ar (deslistados ou bloqueados), para os pausados do Dashboard. Tabela própria, fora de
-- `listings`, como no TikTok Shop.
CREATE TABLE shopee_products (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  item_id            text NOT NULL,
  title              text NOT NULL,
  -- UNLIST (deslistado pelo vendedor), BANNED (bloqueado pela Shopee), REVIEWING
  status             text NOT NULL,
  picture_url        text,
  price              numeric(14,2),
  available_quantity integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, item_id)
);
ALTER TABLE shopee_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee_products FORCE ROW LEVEL SECURITY;
CREATE POLICY shopee_products_tenant_isolation ON shopee_products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
