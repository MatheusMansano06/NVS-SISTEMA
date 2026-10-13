-- Supervisão Full (portado do NVS-WMS): lotes do envio Full, listas de separação, itens, códigos de barras,
-- bipagens e fila de impressão de etiquetas (agente Zebra local). Tudo por empresa (RLS).

CREATE TABLE wms_batches (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  marketplace text NOT NULL DEFAULT 'ml' CHECK (marketplace IN ('ml', 'shopee')),
  full_date   date NOT NULL,
  seq         integer NOT NULL DEFAULT 1,
  name        text NOT NULL,
  inbound_ref text,
  status      text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  lifecycle   text NOT NULL DEFAULT 'pendente' CHECK (lifecycle IN ('pendente', 'em_andamento', 'finalizado')),
  created_by  uuid REFERENCES operators(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wms_lists (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  batch_id     uuid REFERENCES wms_batches(id) ON DELETE CASCADE,
  code         text NOT NULL,
  marketplace  text NOT NULL DEFAULT 'ml',
  operator_id  uuid REFERENCES operators(id) ON DELETE SET NULL,
  status       text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'in_progress', 'completed')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);

CREATE TABLE wms_items (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id        uuid NOT NULL REFERENCES wms_lists(id) ON DELETE CASCADE,
  sku            text NOT NULL,
  ml_code        text,
  ean            text,
  description    text NOT NULL DEFAULT '',
  qty_required   integer NOT NULL CHECK (qty_required > 0),
  qty_picked     integer NOT NULL DEFAULT 0 CHECK (qty_picked >= 0),
  shortage_qty   integer NOT NULL DEFAULT 0,
  status         text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'complete', 'partial', 'out_of_stock')),
  labels_printed boolean NOT NULL DEFAULT false,
  notes          text,
  completed_at   timestamptz
);

CREATE TABLE wms_barcodes (
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  barcode     text NOT NULL,
  sku         text NOT NULL,
  description text,
  is_primary  boolean NOT NULL DEFAULT false,
  added_by    uuid REFERENCES operators(id) ON DELETE SET NULL,
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, barcode, sku)
);

CREATE TABLE wms_scan_events (
  id          bigserial PRIMARY KEY,
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id     uuid NOT NULL REFERENCES wms_lists(id) ON DELETE CASCADE,
  item_id     uuid NOT NULL REFERENCES wms_items(id) ON DELETE CASCADE,
  operator_id uuid REFERENCES operators(id) ON DELETE SET NULL,
  barcode     text NOT NULL,
  event_type  text NOT NULL,
  qty_delta   integer NOT NULL DEFAULT 0,
  at          timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE wms_print_jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  list_id       uuid NOT NULL REFERENCES wms_lists(id) ON DELETE CASCADE,
  sku           text NOT NULL,
  zpl           text NOT NULL,
  labels        integer NOT NULL DEFAULT 0,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PRINTING', 'PRINTED', 'ERROR')),
  job_token     text,
  claimed_by    text,
  printer_name  text,
  error_msg     text,
  operator_id   uuid REFERENCES operators(id) ON DELETE SET NULL,
  retry_count   integer NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  started_at    timestamptz,
  printed_at    timestamptz
);

CREATE UNIQUE INDEX wms_lists_code_idx ON wms_lists (tenant_id, code);
CREATE INDEX wms_lists_batch_idx ON wms_lists (batch_id);
CREATE INDEX wms_lists_status_idx ON wms_lists (tenant_id, marketplace, status);
CREATE INDEX wms_items_list_idx ON wms_items (list_id);
CREATE INDEX wms_items_sku_idx ON wms_items (tenant_id, upper(sku));
CREATE INDEX wms_barcodes_sku_idx ON wms_barcodes (tenant_id, upper(sku));
CREATE INDEX wms_scan_events_list_idx ON wms_scan_events (list_id);
CREATE INDEX wms_scan_events_op_idx ON wms_scan_events (tenant_id, operator_id, at);
CREATE INDEX wms_print_jobs_pending_idx ON wms_print_jobs (tenant_id, status, created_at);
CREATE INDEX wms_print_jobs_item_idx ON wms_print_jobs (list_id, sku);

ALTER TABLE wms_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_batches FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_batches_tenant_isolation ON wms_batches
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wms_lists ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_lists FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_lists_tenant_isolation ON wms_lists
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wms_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_items FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_items_tenant_isolation ON wms_items
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wms_barcodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_barcodes FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_barcodes_tenant_isolation ON wms_barcodes
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wms_scan_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_scan_events FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_scan_events_tenant_isolation ON wms_scan_events
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

ALTER TABLE wms_print_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_print_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_print_jobs_tenant_isolation ON wms_print_jobs
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- Chave do agente de impressão (global: o agente se identifica só pela chave, antes de saber a empresa).
-- Guarda só o hash; a chave aparece uma única vez para quem gerou.
CREATE TABLE wms_print_agent_keys (
  key_hash     text PRIMARY KEY,
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  key_hint     text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz
);
CREATE INDEX wms_print_agent_keys_tenant_idx ON wms_print_agent_keys (tenant_id);
