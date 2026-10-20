-- Radar ADS: métricas do Mercado Ads por campanha e por anúncio (dia a dia), metas de investimento, regras e alertas.
-- O ML guarda 90 dias de métricas; ACOS, ROAS, CTR, CPC e TACOS são calculados a partir dos totais (não ficam gravados).

-- Campanhas como estão no ML agora (configuração usada pelas regras e, depois, pelo robô)
CREATE TABLE ad_campaigns (
  tenant_id        uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id       uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  campaign_id      bigint NOT NULL,
  name             text NOT NULL,
  status           text NOT NULL,
  strategy         text,
  acos_target      numeric(8, 2),
  roas_target      numeric(8, 2),
  budget           numeric(14, 2),
  daily_budget     numeric(14, 2),
  automatic_budget boolean NOT NULL DEFAULT false,
  ml_updated_at    timestamptz,
  fetched_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, campaign_id)
);

-- Anúncios patrocinados (item ↔ campanha) como estão no ML agora
CREATE TABLE ad_items (
  tenant_id     uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id    uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  item_id       text NOT NULL,
  campaign_id   bigint,
  title         text,
  status        text,
  price         numeric(14, 2),
  thumbnail     text,
  logistic_type text,
  fetched_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, item_id)
);
CREATE INDEX ad_items_campaign_idx ON ad_items (tenant_id, account_id, campaign_id);

-- Métricas por campanha e dia (o dia de hoje é regravado a cada leitura até fechar)
CREATE TABLE ad_campaign_daily (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  campaign_id     bigint NOT NULL,
  day             date NOT NULL,
  cost            numeric(14, 2) NOT NULL DEFAULT 0,
  clicks          integer NOT NULL DEFAULT 0,
  prints          bigint NOT NULL DEFAULT 0,
  direct_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  indirect_amount numeric(14, 2) NOT NULL DEFAULT 0,
  units           integer NOT NULL DEFAULT 0,
  organic_units   integer NOT NULL DEFAULT 0,
  organic_amount  numeric(14, 2) NOT NULL DEFAULT 0,
  lost_share_budget numeric(6, 2),   -- % de impressões perdidas por falta de orçamento
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, campaign_id, day)
);
CREATE INDEX ad_campaign_daily_day_idx ON ad_campaign_daily (tenant_id, day DESC);

-- Métricas por anúncio e dia (campanha do dia: o anúncio pode mudar de campanha)
CREATE TABLE ad_item_daily (
  tenant_id       uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id      uuid NOT NULL REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  item_id         text NOT NULL,
  day             date NOT NULL,
  campaign_id     bigint,
  cost            numeric(14, 2) NOT NULL DEFAULT 0,
  clicks          integer NOT NULL DEFAULT 0,
  prints          bigint NOT NULL DEFAULT 0,
  direct_amount   numeric(14, 2) NOT NULL DEFAULT 0,
  indirect_amount numeric(14, 2) NOT NULL DEFAULT 0,
  units           integer NOT NULL DEFAULT 0,
  organic_units   integer NOT NULL DEFAULT 0,
  organic_amount  numeric(14, 2) NOT NULL DEFAULT 0,
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, account_id, item_id, day)
);
CREATE INDEX ad_item_daily_campaign_idx ON ad_item_daily (tenant_id, account_id, campaign_id, day DESC);

-- Metas: gasto do mês, gasto do ano e objetivo de TACOS (account_id null = todas as contas)
CREATE TABLE ad_goals (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id   uuid REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('gasto_mes', 'gasto_ano', 'tacos')),
  period_start date,            -- 1º dia do mês / do ano; null no objetivo de TACOS (vale sempre)
  target       numeric(14, 2) NOT NULL CHECK (target > 0),
  created_by   uuid REFERENCES users(id) ON DELETE SET NULL,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'tacos') = (period_start IS NULL)),
  CHECK (kind <> 'tacos' OR target <= 100)
);
CREATE UNIQUE INDEX ad_goals_unique_idx ON ad_goals
  (tenant_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, COALESCE(period_start, '2000-01-01'::date));

-- Regras: condições (todas precisam bater) sobre a conta ou uma campanha. O robô fica guardado, mas só age na Fase 2.
CREATE TABLE ad_rules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     uuid REFERENCES marketplace_accounts(id) ON DELETE CASCADE,   -- null = todas as contas
  scope          text NOT NULL CHECK (scope IN ('conta', 'campanhas', 'campanha')),  -- campanhas = cada campanha
  campaign_id    bigint,
  name           text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  conditions     jsonb NOT NULL,   -- [{ metric, window, op, value }]
  notify         jsonb NOT NULL DEFAULT '{"sistema": true}',
  robot          jsonb,            -- { action, params, approval, cooldownHours, maxPerDay } — desligado nesta fase
  enabled        boolean NOT NULL DEFAULT true,
  cooldown_hours integer NOT NULL DEFAULT 24 CHECK (cooldown_hours BETWEEN 1 AND 720),
  created_by     uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'campanha') = (campaign_id IS NOT NULL)),
  CHECK (jsonb_typeof(conditions) = 'array' AND jsonb_array_length(conditions) BETWEEN 1 AND 5)
);
CREATE INDEX ad_rules_tenant_idx ON ad_rules (tenant_id, enabled);

-- Disparos das regras (alertas). values = o que foi medido em cada condição.
CREATE TABLE ad_rule_events (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id   uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  rule_id     uuid NOT NULL REFERENCES ad_rules(id) ON DELETE CASCADE,
  account_id  uuid REFERENCES marketplace_accounts(id) ON DELETE CASCADE,
  campaign_id bigint,
  fired_at    timestamptz NOT NULL DEFAULT now(),
  "values"    jsonb NOT NULL,
  message     text NOT NULL,
  read_at     timestamptz
);
CREATE INDEX ad_rule_events_feed_idx ON ad_rule_events (tenant_id, fired_at DESC);
CREATE INDEX ad_rule_events_cooldown_idx ON ad_rule_events (rule_id, campaign_id, fired_at DESC);

-- Situação da leitura das métricas por conta
ALTER TABLE ad_accounts ADD COLUMN metrics_synced_at timestamptz;
ALTER TABLE ad_accounts ADD COLUMN metrics_backfilled_at timestamptz;   -- carga dos 90 dias concluída

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['ad_campaigns', 'ad_items', 'ad_campaign_daily', 'ad_item_daily', 'ad_goals', 'ad_rules', 'ad_rule_events'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY %I ON %I USING (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)
         WITH CHECK (tenant_id = NULLIF(current_setting(''app.tenant_id'', true), '''')::uuid)',
      t || '_tenant_isolation', t);
  END LOOP;
END $$;

-- Em teste: liberado só na empresa piloto (Novaes); fica fora do padrão de empresa e plano novos.
UPDATE tenants SET features = array_append(features, 'radar_ads'), features_custom = true
  WHERE cnpj = '06226411000186' AND NOT 'radar_ads' = ANY(features);
