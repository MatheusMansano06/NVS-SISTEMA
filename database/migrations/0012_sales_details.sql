-- Aba Vendas: comprador, carrinho, forma de pagamento e destino de cada pedido; configuração de DIFAL por empresa.
ALTER TABLE orders ADD COLUMN buyer_nickname text;
ALTER TABLE orders ADD COLUMN pack_id text;              -- carrinho (vários pedidos num pacote)
ALTER TABLE orders ADD COLUMN payment_type text;         -- account_money | credit_card | debit_card | bank_transfer (Pix) | ticket…
ALTER TABLE orders ADD COLUMN installments integer;
ALTER TABLE orders ADD COLUMN ship_state text;           -- UF de destino (ex.: SP)
ALTER TABLE orders ADD COLUMN ship_city text;
ALTER TABLE orders ADD COLUMN ship_zip text;
ALTER TABLE orders ADD COLUMN address_checked_at timestamptz;  -- endereço já consultado (mesmo se indisponível)
CREATE INDEX orders_tenant_state_idx ON orders (tenant_id, ship_state);
CREATE INDEX orders_address_pending_idx ON orders (tenant_id, account_id) WHERE address_checked_at IS NULL AND shipping_ref IS NOT NULL;

CREATE TABLE difal_settings (
  tenant_id      uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  origin_uf      text NOT NULL DEFAULT 'SP' CHECK (origin_uf ~ '^[A-Z]{2}$'),
  imported       boolean NOT NULL DEFAULT false,      -- trata como importado (interestadual 4%)
  internal_rates jsonb NOT NULL DEFAULT '{}',         -- alíquota interna por UF que difere do padrão
  updated_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at     timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE difal_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE difal_settings FORCE ROW LEVEL SECURITY;
CREATE POLICY difal_settings_tenant_isolation ON difal_settings
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
