-- Estoque virtual do sistema (sem ERP ligado): o que não volta para o estoque do anúncio no Mercado Livre — produto
-- quebrado/avariado, divergente, ou vendável sem anúncio próprio (só Full). Saldo = soma dos movimentos.
CREATE TABLE virtual_stock_moves (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku            text NOT NULL,
  deposit        text NOT NULL CHECK (deposit IN ('vendavel', 'avaria')),
  quantity       integer NOT NULL CHECK (quantity <> 0),   -- entrada positiva, saída negativa
  origin         text NOT NULL,                            -- devolucao | retorno_full | ajuste
  reference      text,                                     -- id da devolução ou etiqueta do Full
  operator_name  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX virtual_stock_moves_sku_idx ON virtual_stock_moves (tenant_id, sku, deposit);

ALTER TABLE virtual_stock_moves ENABLE ROW LEVEL SECURITY;
ALTER TABLE virtual_stock_moves FORCE ROW LEVEL SECURITY;
CREATE POLICY virtual_stock_moves_tenant_isolation ON virtual_stock_moves
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
