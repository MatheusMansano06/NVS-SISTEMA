-- Cadastro de SKUs: custo unitário e imposto por SKU, com histórico de vigência.
-- Regras herdadas do NVS-WMS: custo > 0, imposto 0..100, venda usa o custo vigente na data do pedido,
-- SKU sem custo = margem desconhecida (nunca "zero").

CREATE TABLE sku_costs (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku         text NOT NULL,
  custo_unit  numeric(14, 2) NOT NULL CHECK (custo_unit > 0),
  imposto_pct numeric(5, 2) NOT NULL DEFAULT 0 CHECK (imposto_pct BETWEEN 0 AND 100),
  updated_by  uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, sku)
);

-- Vigências: custo NULL = removido (a partir dali, custo desconhecido).
CREATE TABLE sku_cost_history (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku           text NOT NULL,
  custo_unit    numeric(14, 2),
  imposto_pct   numeric(5, 2),
  vigente_desde date NOT NULL,
  origem        text NOT NULL CHECK (origem IN ('cadastro', 'importacao', 'removido')),
  registrado_por uuid REFERENCES users(id) ON DELETE SET NULL,
  registrado_em timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sku_cost_history_lookup_idx ON sku_cost_history (tenant_id, sku, vigente_desde DESC, registrado_em DESC);

-- Itens: custo NULL = desconhecido; imposto % aplicado na data da venda.
ALTER TABLE order_items ALTER COLUMN unit_cost DROP NOT NULL;
ALTER TABLE order_items ALTER COLUMN unit_cost DROP DEFAULT;
ALTER TABLE order_items ADD COLUMN tax_pct numeric(5, 2);
CREATE INDEX order_items_tenant_sku_order_idx ON order_items (tenant_id, sku, order_id);

-- Pedidos: imposto total e se todos os itens têm custo conhecido.
ALTER TABLE orders ADD COLUMN tax_amount numeric(14, 2) NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN cost_known boolean NOT NULL DEFAULT false;

-- Anúncios: SKU do vendedor (no anúncio e nas variações) para montar o cadastro.
ALTER TABLE listings ADD COLUMN sku text;
ALTER TABLE listings ADD COLUMN variation_skus text[] NOT NULL DEFAULT '{}';
CREATE INDEX listings_tenant_sku_idx ON listings (tenant_id, sku);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sku_costs', 'sku_cost_history'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
       WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
