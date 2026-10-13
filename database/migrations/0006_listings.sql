-- Anúncios (catálogo do marketplace): fotos dos mais vendidos e anúncios pausados.
ALTER TABLE order_items ADD COLUMN listing_id text;  -- código do anúncio (ex.: MLB123...)
CREATE INDEX order_items_listing_idx ON order_items (tenant_id, listing_id);

CREATE TABLE listings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  marketplace        text NOT NULL,
  external_id        text NOT NULL,
  title              text NOT NULL,
  picture_url        text,
  permalink          text,
  price              numeric(14, 2),
  available_quantity integer,
  status             text NOT NULL,               -- active | paused | closed | under_review | inactive
  sub_status         text[] NOT NULL DEFAULT '{}', -- ex.: {out_of_stock}
  source             text NOT NULL DEFAULT 'marketplace' CHECK (source IN ('marketplace', 'demo')),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, marketplace, external_id)
);
CREATE INDEX listings_tenant_status_idx ON listings (tenant_id, status, account_id);

ALTER TABLE listings ENABLE ROW LEVEL SECURITY;
ALTER TABLE listings FORCE ROW LEVEL SECURITY;
CREATE POLICY listings_tenant_isolation ON listings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
