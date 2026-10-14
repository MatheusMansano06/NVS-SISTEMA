-- Central de Devoluções igual à do NOVAES-ESTOQUE: log de conferências por operador, resultado do lançamento de
-- estoque, dados que o B.I consulta uma vez na plataforma (Full x orgânica, quem abriu a mediação, se a empresa atuou),
-- tarifas de devolução da fatura do ML, fechamento mensal gravado e o Retorno do Full. Tudo por empresa (RLS).

-- Venda Full x orgânica e mediação (preenchidos em segundo plano; a sincronização das reclamações não toca nestas colunas)
ALTER TABLE returns ADD COLUMN sale_logistic text;               -- logistic_type do envio de ida (fulfillment = Full)
ALTER TABLE returns ADD COLUMN mediation_opened_by text;         -- vendedor | comprador | plataforma | desconhecido
ALTER TABLE returns ADD COLUMN mediation_actions text;           -- ações da empresa (respondent) na reclamação, separadas por vírgula
ALTER TABLE returns ADD COLUMN mediation_actions_closed boolean;
ALTER TABLE returns ADD COLUMN mediation_actions_at timestamptz;

ALTER TABLE return_checks ADD COLUMN stock_result jsonb;

-- Evidência: foto ou vídeo (o vídeo não vai pela API do ML, mas fica na conferência para o chamado manual)
ALTER TABLE return_evidence ADD COLUMN kind text NOT NULL DEFAULT 'foto' CHECK (kind IN ('foto', 'video'));

ALTER TABLE return_replies DROP CONSTRAINT IF EXISTS return_replies_text_check;
ALTER TABLE return_replies ADD CONSTRAINT return_replies_text_check CHECK (length(text) BETWEEN 1 AND 500);

-- Quem registrou o custo pela Central (operador da equipe, não usuário da conta)
ALTER TABLE sku_cost_history ADD COLUMN registrado_por_nome text;

CREATE TABLE return_check_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id      uuid REFERENCES returns(id) ON DELETE SET NULL,
  operator_id    uuid REFERENCES operators(id) ON DELETE SET NULL,
  operator_name  text NOT NULL,
  platform       text NOT NULL,
  order_id       text,
  class          text NOT NULL,
  dispute        boolean NOT NULL,
  manual_ticket  boolean NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX return_check_log_time_idx ON return_check_log (tenant_id, created_at);

-- Tarifas de devolução como estão na fatura do ML (ciclo do dia 13 ao 12; chave "AAAA-MM-01")
CREATE TABLE ml_billing_returns (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  detail_id  text NOT NULL,
  invoice    text NOT NULL,
  kind       text NOT NULL,
  order_id   text,
  amount     numeric(14, 2) NOT NULL,   -- cobrança positiva, estorno negativo
  day        date,
  PRIMARY KEY (tenant_id, detail_id)
);
CREATE INDEX ml_billing_returns_invoice_idx ON ml_billing_returns (tenant_id, invoice);

CREATE TABLE return_month_close (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invoice    text NOT NULL,
  data       jsonb NOT NULL,
  closed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, invoice)
);

-- Retorno do Full: o que voltou do CD do ML para o estoque, bipado pela etiqueta do Full
CREATE TABLE full_withdrawals (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code           text NOT NULL,
  item_id        text,
  title          text,
  thumbnail      text,
  sku            text NOT NULL,
  quantity       integer NOT NULL CHECK (quantity BETWEEN 1 AND 999),
  unit_cost      numeric(14, 2),
  operator_name  text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX full_withdrawals_time_idx ON full_withdrawals (tenant_id, created_at);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['return_check_log', 'ml_billing_returns', 'return_month_close', 'full_withdrawals'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;
