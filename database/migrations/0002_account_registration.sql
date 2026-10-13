-- Cadastro simplificado (e-mail + telefone + CNPJ) e login global por e-mail.
ALTER TABLE tenants ADD COLUMN cnpj text UNIQUE CHECK (cnpj ~ '^[0-9]{14}$');
ALTER TABLE tenants ADD COLUMN phone text;

ALTER TABLE users ADD COLUMN phone text;
ALTER TABLE users ADD COLUMN must_change_password boolean NOT NULL DEFAULT false;

-- Índice global e-mail -> tenant, sem RLS: permite descobrir a empresa no login sem pedir "slug".
-- Um e-mail pertence a uma única empresa.
CREATE TABLE login_identities (
  email     text PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id   uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX login_identities_tenant_idx ON login_identities (tenant_id);
