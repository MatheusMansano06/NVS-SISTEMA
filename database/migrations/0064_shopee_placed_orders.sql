-- Shopee: todo pedido feito (inclusive os nunca pagos), para o funil "Pedido Feito × Pedido Pago" do Seller Center.
-- A venda em `orders` passa a ser datada pelo pagamento (como o filtro padrão "Pedido Pago" da Shopee);
-- aqui fica a data de criação, o pagamento (se houve) e o valor, para medir a intenção de compra.
CREATE TABLE shopee_placed_orders (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  order_sn      text NOT NULL,
  placed_at     timestamptz NOT NULL,
  paid_at       timestamptz,
  status        text NOT NULL,
  -- soma dos itens pelo preço de venda (com as promoções do vendedor)
  amount        numeric(14,2) NOT NULL DEFAULT 0,
  -- total pago pelo comprador (com frete e cupons), como a Shopee informa
  total_amount  numeric(14,2),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, order_sn)
);
CREATE INDEX shopee_placed_orders_placed ON shopee_placed_orders (tenant_id, placed_at);
CREATE INDEX shopee_placed_orders_paid ON shopee_placed_orders (tenant_id, paid_at) WHERE paid_at IS NOT NULL;

ALTER TABLE shopee_placed_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE shopee_placed_orders FORCE ROW LEVEL SECURITY;
CREATE POLICY shopee_placed_orders_tenant_isolation ON shopee_placed_orders
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- refaz o histórico: as vendas passam a ser datadas pelo pagamento e o funil precisa dos pedidos antigos
UPDATE shopee_connections SET backfilled = false;
