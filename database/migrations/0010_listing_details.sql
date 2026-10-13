-- Anúncios: dados exibidos na aba Anúncios (vendidos, tipo, frete, logística, fotos, dimensões).
ALTER TABLE listings ADD COLUMN sold_quantity integer;
ALTER TABLE listings ADD COLUMN listing_type_id text;       -- gold_special (Clássico) | gold_pro (Premium) | free
ALTER TABLE listings ADD COLUMN category_id text;
ALTER TABLE listings ADD COLUMN free_shipping boolean NOT NULL DEFAULT false;
ALTER TABLE listings ADD COLUMN logistic_type text;         -- fulfillment (Full) | self_service (Flex) | cross_docking | drop_off…
ALTER TABLE listings ADD COLUMN catalog_listing boolean NOT NULL DEFAULT false;
ALTER TABLE listings ADD COLUMN pictures_count integer;
ALTER TABLE listings ADD COLUMN dimensions text;            -- "LxAxC,peso_g" como o ML devolve
ALTER TABLE listings ADD COLUMN listed_at timestamptz;      -- date_created no marketplace
CREATE INDEX listings_tenant_title_idx ON listings (tenant_id, status, listed_at DESC);

-- Tarifa/frete consultados ao vivo ficam salvos: só são buscados de novo quando o preço muda.
ALTER TABLE listings ADD COLUMN fee_amount numeric(14, 2);
ALTER TABLE listings ADD COLUMN fee_pct numeric(6, 2);
ALTER TABLE listings ADD COLUMN freight_cost numeric(14, 2);
ALTER TABLE listings ADD COLUMN pricing_price numeric(14, 2);  -- preço para o qual a tarifa/frete valem
ALTER TABLE listings ADD COLUMN pricing_at timestamptz;
