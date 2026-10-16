-- DRE simplificado: gastos que a empresa lança à mão (o que vem do Mercado Livre — vendas, tarifas, frete, Ads,
-- DIFAL — é calculado automaticamente). Cada lançamento vale de start_month até end_month (null = sem fim).
CREATE TABLE dre_entries (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name         text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  kind         text NOT NULL CHECK (kind IN ('custo_variavel', 'despesa_fixa', 'despesa_financeira')),
  category     text NOT NULL CHECK (category IN ('pessoas', 'estrutura', 'sistemas', 'servicos', 'marketing', 'logistica', 'financeiro', 'outros')),
  -- mensal: valor por mês · pedido: valor por pedido vendido · percentual: % do faturamento · unico: só no mês de início
  basis        text NOT NULL CHECK (basis IN ('mensal', 'pedido', 'percentual', 'unico')),
  amount       numeric(14, 2) NOT NULL CHECK (amount >= 0),
  start_month  date NOT NULL,   -- 1º dia do mês
  end_month    date,            -- 1º dia do último mês em que vale
  notes        text,
  details      jsonb,         -- pessoa da equipe: vínculo, regime, salário e benefícios (custo recalculável)
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (end_month IS NULL OR end_month >= start_month),
  CHECK (basis <> 'percentual' OR amount <= 100)
);
CREATE INDEX dre_entries_tenant_idx ON dre_entries (tenant_id, start_month);

ALTER TABLE dre_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE dre_entries FORCE ROW LEVEL SECURITY;
CREATE POLICY dre_entries_tenant_isolation ON dre_entries
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
