-- Histórico de vendas guardado mês a mês (até 12 meses antes dos 90 dias da sincronização completa): cada mês é
-- buscado uma vez no Mercado Livre e não é relido — o histórico fica no banco e as comparações fazem sentido.
CREATE TABLE ml_history_months (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id  uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  month       date NOT NULL,              -- 1º dia do mês
  orders      integer NOT NULL DEFAULT 0,
  done_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, month)
);
ALTER TABLE ml_history_months ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_history_months FORCE ROW LEVEL SECURITY;
CREATE POLICY ml_history_months_tenant_isolation ON ml_history_months
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
