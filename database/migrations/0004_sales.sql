-- Vendas: contas de marketplace, pedidos e itens. Base do dashboard.
-- `source = 'demo'` marca dados de demonstração (removíveis) até a integração real existir.

CREATE TABLE marketplace_accounts (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marketplace text NOT NULL CHECK (marketplace IN ('mercado_livre', 'shopee', 'tiktok_shop')),
  nickname    text NOT NULL,
  external_id text,
  source      text NOT NULL DEFAULT 'marketplace' CHECK (source IN ('marketplace', 'demo')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, marketplace, external_id)
);

CREATE TABLE orders (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  marketplace     text NOT NULL,
  external_id     text NOT NULL,
  status          text NOT NULL CHECK (status IN ('paid', 'cancelled', 'returned')),
  ordered_at      timestamptz NOT NULL,
  gross_amount    numeric(14, 2) NOT NULL CHECK (gross_amount >= 0),  -- faturamento
  marketplace_fee numeric(14, 2) NOT NULL DEFAULT 0,                  -- tarifa de venda
  shipping_cost   numeric(14, 2) NOT NULL DEFAULT 0,                  -- frete pago pelo vendedor
  product_cost    numeric(14, 2) NOT NULL DEFAULT 0,                  -- custo das mercadorias
  units           integer NOT NULL DEFAULT 0,
  source          text NOT NULL DEFAULT 'marketplace' CHECK (source IN ('marketplace', 'demo')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, marketplace, external_id)
);
-- consultas do dashboard filtram sempre por tenant + período (e opcionalmente conta)
CREATE INDEX orders_tenant_time_idx ON orders (tenant_id, ordered_at);
CREATE INDEX orders_tenant_account_time_idx ON orders (tenant_id, account_id, ordered_at);

CREATE TABLE order_items (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  order_id   uuid NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  sku        text NOT NULL,
  title      text NOT NULL,
  quantity   integer NOT NULL CHECK (quantity > 0),
  unit_price numeric(14, 2) NOT NULL,
  unit_cost  numeric(14, 2) NOT NULL DEFAULT 0
);
CREATE INDEX order_items_order_idx ON order_items (order_id);
CREATE INDEX order_items_tenant_sku_idx ON order_items (tenant_id, sku);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['marketplace_accounts', 'orders', 'order_items'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
