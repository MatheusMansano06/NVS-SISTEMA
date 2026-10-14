-- Painel Master (dono do NVS Tech): administradores da plataforma, planos, assinaturas, mensalidades, cupons de
-- desconto, comunicados para os usuários e o registro do que a master fez. Tabelas globais (sem RLS): só o servidor
-- acessa, e o que cada empresa vê é filtrado por ela no serviço.

CREATE TABLE platform_admins (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email          text NOT NULL UNIQUE,
  name           text NOT NULL,
  password_hash  text NOT NULL,
  is_active      boolean NOT NULL DEFAULT true,
  last_login_at  timestamptz,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plans (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL,
  price       numeric(14, 2) NOT NULL CHECK (price >= 0),
  description text,
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE coupons (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code             text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,30}$'),
  description      text,
  kind             text NOT NULL CHECK (kind IN ('percent', 'fixed')),
  value            numeric(14, 2) NOT NULL CHECK (value > 0),
  duration         text NOT NULL CHECK (duration IN ('once', 'months', 'forever')),
  months           integer CHECK (months IS NULL OR months BETWEEN 1 AND 60),
  max_redemptions  integer CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  redemptions      integer NOT NULL DEFAULT 0,
  valid_until      date,
  active           boolean NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (duration <> 'months' OR months IS NOT NULL)
);

CREATE TABLE subscriptions (
  tenant_id          uuid PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  plan_id            uuid REFERENCES plans(id) ON DELETE SET NULL,
  price              numeric(14, 2) CHECK (price IS NULL OR price >= 0), -- preço combinado (NULL = do plano)
  status             text NOT NULL DEFAULT 'trial' CHECK (status IN ('trial', 'active', 'past_due', 'canceled')),
  trial_ends_on      date,
  billing_day        integer NOT NULL DEFAULT 10 CHECK (billing_day BETWEEN 1 AND 28),
  coupon_id          uuid REFERENCES coupons(id) ON DELETE SET NULL,
  coupon_cycles_left integer,                -- ciclos de desconto que faltam (NULL = para sempre)
  notes              text,
  started_at         timestamptz NOT NULL DEFAULT now(),
  canceled_at        timestamptz,
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE invoices (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  period       date NOT NULL,                -- 1º dia do mês de referência
  description  text NOT NULL,
  amount       numeric(14, 2) NOT NULL CHECK (amount >= 0),
  discount     numeric(14, 2) NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total        numeric(14, 2) NOT NULL CHECK (total >= 0),
  coupon_code  text,
  due_date     date NOT NULL,
  status       text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'paid', 'canceled')),
  paid_at      timestamptz,
  method       text,                         -- pix | boleto | cartao | transferencia | outro
  notes        text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, period)
);
CREATE INDEX invoices_status_due_idx ON invoices (status, due_date);

CREATE TABLE announcements (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
  body        text NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  level       text NOT NULL DEFAULT 'info' CHECK (level IN ('info', 'success', 'warning', 'danger')),
  audience    text NOT NULL DEFAULT 'all' CHECK (audience IN ('all', 'tenants')),
  tenant_ids  uuid[] NOT NULL DEFAULT '{}',
  starts_at   timestamptz NOT NULL DEFAULT now(),
  ends_at     timestamptz,
  active      boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX announcements_active_idx ON announcements (active, starts_at);

CREATE TABLE announcement_dismissals (
  announcement_id uuid NOT NULL REFERENCES announcements(id) ON DELETE CASCADE,
  user_id         uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  dismissed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (announcement_id, user_id)
);

CREATE TABLE admin_audit (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id   uuid REFERENCES platform_admins(id) ON DELETE SET NULL,
  action     text NOT NULL,
  target     text,
  details    jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_time_idx ON admin_audit (created_at DESC);
