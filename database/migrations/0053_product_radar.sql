-- Produto Campeão: produtos estudados pelo agente de viabilidade (Claude no Chrome + Avantpro), um por busca e dia,
-- com os anúncios analisados. Regravar a mesma busca no mesmo dia substitui o estudo.
CREATE TABLE product_radar_products (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day                  date NOT NULL,
  mode                 text NOT NULL CHECK (mode IN ('diario', 'avulso')),
  category             text,
  search               text NOT NULL,
  source_title         text,
  verdict              text NOT NULL CHECK (verdict IN ('viavel', 'arriscado', 'inviavel')),
  note                 text,
  analyzed             integer NOT NULL,
  pass_sales           integer NOT NULL,
  pass_reviews         integer NOT NULL,
  approved             integer NOT NULL,
  leader_sales_per_day numeric(12, 1) NOT NULL DEFAULT 0,
  thumbnail            text,
  listings             jsonb NOT NULL CHECK (jsonb_typeof(listings) = 'array'),
  created_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, day, search)
);
CREATE INDEX product_radar_products_day_idx ON product_radar_products (tenant_id, day DESC);

ALTER TABLE product_radar_products ENABLE ROW LEVEL SECURITY;
ALTER TABLE product_radar_products FORCE ROW LEVEL SECURITY;
CREATE POLICY product_radar_products_tenant_isolation ON product_radar_products
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Em teste: liberado só na empresa piloto (Novaes); fica fora do padrão de empresa e plano novos.
UPDATE tenants SET features = array_append(features, 'radar_produtos'), features_custom = true
  WHERE cnpj = '06226411000186' AND NOT 'radar_produtos' = ANY(features);
