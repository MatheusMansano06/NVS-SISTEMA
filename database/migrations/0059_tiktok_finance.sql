-- TikTok Shop: extrato financeiro fiel. Cada linha é uma transação de um extrato diário do TikTok (repasse de um
-- pedido, estorno ou ajuste). Os totais do pedido (tarifas, frete, devolução) são a SOMA das transações dele, então
-- reler um extrato não duplica nada e um estorno posterior entra sozinho.
CREATE TABLE tiktok_statement_transactions (
  tenant_id         uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id        uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  transaction_id    text NOT NULL,
  statement_id      text NOT NULL,
  statement_time    timestamptz NOT NULL,
  type              text NOT NULL,
  order_external_id text,
  -- valores já normalizados: receita líquida do pedido; tarifa e frete como CUSTO do vendedor (positivo = cobrado)
  revenue           numeric(14,2) NOT NULL DEFAULT 0,
  fee               numeric(14,2) NOT NULL DEFAULT 0,
  shipping          numeric(14,2) NOT NULL DEFAULT 0,
  -- ajuste do TikTok (positivo = crédito para o vendedor)
  adjustment        numeric(14,2) NOT NULL DEFAULT 0,
  settlement        numeric(14,2) NOT NULL DEFAULT 0,
  refund            numeric(14,2) NOT NULL DEFAULT 0,
  -- composição original do TikTok (comissão, afiliado, tarifa por item, frete...), só os campos diferentes de zero
  breakdown         jsonb NOT NULL DEFAULT '{}',
  PRIMARY KEY (tenant_id, account_id, transaction_id)
);
CREATE INDEX tiktok_statement_transactions_order_idx ON tiktok_statement_transactions (tenant_id, account_id, order_external_id);

ALTER TABLE tiktok_statement_transactions ENABLE ROW LEVEL SECURITY;
ALTER TABLE tiktok_statement_transactions FORCE ROW LEVEL SECURITY;
CREATE POLICY tiktok_statement_transactions_tenant_isolation ON tiktok_statement_transactions
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- até que data os extratos já foram lidos (a leitura seguinte recomeça um pouco antes, por segurança)
ALTER TABLE tiktok_connections ADD COLUMN statements_until timestamptz;

-- foto do item vinda do próprio pedido (marketplaces sem anúncio sincronizado, como o TikTok Shop)
ALTER TABLE order_items ADD COLUMN picture_url text;
