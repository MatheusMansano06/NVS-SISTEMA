-- Conferência diária da impressora (Supervisão Full): no 1º uso do dia alguém imprime a etiqueta de teste e confirma
-- que saiu legível; vale para a empresa toda no dia (o mesmo computador é usado por várias pessoas).
CREATE TABLE wms_printer_checks (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  day           date NOT NULL,
  machine       text,
  printer_name  text,
  confirmed_by  text NOT NULL,
  confirmed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, day)
);
ALTER TABLE wms_printer_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE wms_printer_checks FORCE ROW LEVEL SECURITY;
CREATE POLICY wms_printer_checks_tenant_isolation ON wms_printer_checks
  USING (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id', true), '')::uuid);

-- etiqueta de teste não pertence a nenhuma lista
ALTER TABLE wms_print_jobs ALTER COLUMN list_id DROP NOT NULL;
