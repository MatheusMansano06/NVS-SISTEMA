-- Precificador › Viabilidade: fornecedor vira pasta, com o % que soma ao preço da cotação (IPI/ST/frete de compra).
-- A ficha continua guardando o nome em pricing_studies.supplier; a pasta casa pelo nome (sem diferenciar maiúsculas).
CREATE TABLE pricing_suppliers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name             text NOT NULL,
  cost_markup_pct  numeric(5, 2) NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX pricing_suppliers_name_idx ON pricing_suppliers (tenant_id, lower(name));
ALTER TABLE pricing_suppliers ENABLE ROW LEVEL SECURITY;
ALTER TABLE pricing_suppliers FORCE ROW LEVEL SECURITY;
CREATE POLICY pricing_suppliers_tenant_isolation ON pricing_suppliers
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Origem do custo: preço na cotação do fornecedor (antes do %), nome da cotação e a linha dela.
ALTER TABLE pricing_studies
  ADD COLUMN supplier_cost numeric(14, 2),
  ADD COLUMN quote_ref     text,
  ADD COLUMN quote_item    text;

-- As pastas dos fornecedores já digitados nas fichas são criadas pelo app ao listar (dentro do RLS de cada empresa).
