-- TikTok Shop: catálogo da loja (situação, preço e estoque de cada produto), para os anúncios pausados do Dashboard.
-- Tabela própria, fora de `listings`: as telas do Mercado Livre leem `listings` sem filtrar marketplace.
CREATE TABLE tiktok_products (
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  product_id         text NOT NULL,
  title              text NOT NULL,
  -- situação como o TikTok devolve: ACTIVATE, SELLER_DEACTIVATED, PLATFORM_DEACTIVATED, FREEZE, DRAFT, PENDING, FAILED...
  status             text NOT NULL,
  picture_url        text,
  -- menor preço entre as variações
  price              numeric(14,2),
  -- soma do estoque de todas as variações e armazéns
  available_quantity integer,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, product_id)
);
CREATE INDEX tiktok_products_status_idx ON tiktok_products (tenant_id, status, account_id);

ALTER TABLE tiktok_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_products FORCE ROW LEVEL SECURITY;
CREATE POLICY tiktok_products_tenant_isolation ON tiktok_products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
