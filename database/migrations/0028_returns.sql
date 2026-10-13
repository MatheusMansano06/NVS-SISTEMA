-- Central de Devoluções (portada do NOVAES-ESTOQUE): devoluções do ML (pós-venda), códigos que levam a elas no
-- bipe, conferência da bancada, fotos de evidência, contestações enviadas e respostas prontas. Tudo por empresa (RLS).
-- A sincronização só grava em `returns`/`return_codes`; o trabalho do operador fica nas outras tabelas.

CREATE TABLE returns (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id         uuid REFERENCES marketplace_accounts(id) ON DELETE SET NULL,
  marketplace        text NOT NULL DEFAULT 'mercado_livre',
  external_id        text NOT NULL,
  order_id           text NOT NULL,
  pack_id            text,
  tracking           text,
  stage              text NOT NULL CHECK (stage IN ('solicitada', 'em_transito', 'entregue', 'encerrada', 'cancelada')),
  platform_status    text NOT NULL,
  in_mediation       boolean NOT NULL DEFAULT false,
  can_dispute        boolean NOT NULL DEFAULT false,
  awaiting_review    boolean NOT NULL DEFAULT false,
  reason             text NOT NULL,
  reason_platform    text NOT NULL,
  responsible        text NOT NULL CHECK (responsible IN ('comprador', 'vendedor', 'a_definir')),
  destination        text NOT NULL CHECK (destination IN ('vendedor', 'cd_plataforma', 'sem_retorno')),
  platform_cost      numeric(14, 2),
  affects_reputation boolean,
  product_condition  text,
  mediation_result   text,
  coverage_applied   boolean,
  seller_deadline    timestamptz,
  items              jsonb NOT NULL DEFAULT '[]',
  opened_at          timestamptz NOT NULL,
  updated_at         timestamptz NOT NULL,
  raw                jsonb NOT NULL DEFAULT '{}',
  synced_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_codes (
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code       text NOT NULL,
  return_id  uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  origin     text NOT NULL,
  PRIMARY KEY (tenant_id, code, return_id)
);

CREATE TABLE return_checks (
  return_id        uuid PRIMARY KEY REFERENCES returns(id) ON DELETE CASCADE,
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  sku_received     text,
  product_correct  boolean NOT NULL,
  complete         boolean NOT NULL,
  unused           boolean NOT NULL,
  resellable       boolean NOT NULL,
  our_error        boolean NOT NULL,
  note             text,
  class            text NOT NULL CHECK (class IN ('A', 'B', 'C')),
  stock_moves      jsonb NOT NULL DEFAULT '[]',
  dispute          boolean NOT NULL,
  decision         text NOT NULL,
  manual_ticket    boolean NOT NULL DEFAULT false,
  ticket_opened_at timestamptz,
  ticket_protocol  text,
  product_loss     numeric(14, 2),
  reverse_freight  numeric(14, 2),
  stock_done_at    timestamptz,
  checked_by       uuid REFERENCES operators(id) ON DELETE SET NULL,
  checked_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_evidence (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id   uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  mime        text NOT NULL,
  bytes       bytea NOT NULL,
  size        integer NOT NULL,
  added_by    uuid REFERENCES operators(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_disputes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  return_id   uuid NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  reason      text NOT NULL,
  message     text NOT NULL,
  ok          boolean NOT NULL,
  path        text,
  attachments jsonb NOT NULL DEFAULT '[]',
  warning     text,
  error       text,
  sent_by     uuid REFERENCES operators(id) ON DELETE SET NULL,
  sent_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE return_replies (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  text       text NOT NULL CHECK (length(text) BETWEEN 1 AND 300),
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX returns_external_idx ON returns (tenant_id, marketplace, external_id);
CREATE INDEX returns_opened_idx ON returns (tenant_id, opened_at);
CREATE INDEX returns_order_idx ON returns (tenant_id, order_id);
CREATE INDEX return_codes_return_idx ON return_codes (return_id);
CREATE INDEX return_evidence_return_idx ON return_evidence (return_id);
CREATE INDEX return_disputes_return_idx ON return_disputes (return_id);

ALTER TABLE returns ENABLE ROW LEVEL SECURITY;
ALTER TABLE returns FORCE ROW LEVEL SECURITY;
CREATE POLICY returns_tenant_isolation ON returns
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE return_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY return_codes_tenant_isolation ON return_codes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE return_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY return_checks_tenant_isolation ON return_checks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE return_evidence ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_evidence FORCE ROW LEVEL SECURITY;
CREATE POLICY return_evidence_tenant_isolation ON return_evidence
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE return_disputes ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_disputes FORCE ROW LEVEL SECURITY;
CREATE POLICY return_disputes_tenant_isolation ON return_disputes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE return_replies ENABLE ROW LEVEL SECURITY;
ALTER TABLE return_replies FORCE ROW LEVEL SECURITY;
CREATE POLICY return_replies_tenant_isolation ON return_replies
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);
