-- Central de Marketing: raio-X de cada anúncio ativo (o que ele usa das ferramentas do ML), lido aos poucos em
-- segundo plano para não bater no limite da API. NULL = o ML não informou para esta conta (ferramenta indisponível).
CREATE TABLE listing_marketing (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  item_id           text NOT NULL,
  promos_active     text[] NOT NULL DEFAULT '{}',   -- tipos de promoção em que participa (started/pending)
  promos_candidate  text[] NOT NULL DEFAULT '{}',   -- tipos em que poderia entrar (candidate)
  wholesale         boolean,                        -- preço de atacado (faixas por quantidade)
  clips             boolean,                        -- clips publicados no anúncio
  video             boolean,                        -- vídeo (video_id) no anúncio
  ads               text,                           -- Mercado Ads: active | paused | none | NULL (sem leitura)
  checked_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, item_id)
);
CREATE INDEX listing_marketing_checked_idx ON listing_marketing (tenant_id, account_id, checked_at);
ALTER TABLE listing_marketing ENABLE ROW LEVEL SECURITY;
ALTER TABLE listing_marketing FORCE ROW LEVEL SECURITY;
CREATE POLICY listing_marketing_tenant_isolation ON listing_marketing
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
