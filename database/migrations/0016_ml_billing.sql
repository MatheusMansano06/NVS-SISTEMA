-- Faturamento do Mercado Livre por mês (resumo da fatura): cobranças, bonificações e o ICMS-DIFAL cobrado.
CREATE TABLE ml_billing_periods (
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  period_key   date NOT NULL,                  -- 1º dia do mês da fatura (ex.: 2026-10-01)
  date_from    date,
  date_to      date,
  status       text,                            -- OPEN | CLOSED
  total_amount numeric(14, 2),
  difal        numeric(14, 2) NOT NULL DEFAULT 0, -- "Cobrança do diferencial de alíquota interestadual (ICMS-DIFAL)"
  charges      jsonb NOT NULL DEFAULT '[]',
  bonuses      jsonb NOT NULL DEFAULT '[]',
  fetched_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, period_key)
);
ALTER TABLE ml_billing_periods ENABLE ROW LEVEL SECURITY;
ALTER TABLE ml_billing_periods FORCE ROW LEVEL SECURITY;
CREATE POLICY ml_billing_periods_tenant_isolation ON ml_billing_periods
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
