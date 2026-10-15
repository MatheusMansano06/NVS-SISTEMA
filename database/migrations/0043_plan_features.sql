-- Recursos por plano e por empresa. Tudo o que já existia continua liberado (menos a Supervisão Full, em teste);
-- empresa nova nasce com o padrão. features_custom = ajustada à mão no Master (não segue mais o plano).
ALTER TABLE plans ADD COLUMN features text[] NOT NULL
  DEFAULT ARRAY['financeiro', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
ALTER TABLE tenants ALTER COLUMN features
  SET DEFAULT ARRAY['financeiro', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
UPDATE tenants SET features = ARRAY['financeiro', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes']
  || CASE WHEN 'full' = ANY(features) THEN ARRAY['full'] ELSE ARRAY[]::text[] END;
ALTER TABLE tenants ADD COLUMN features_custom boolean NOT NULL DEFAULT false;
-- a empresa piloto da Supervisão Full já foi ajustada à mão
UPDATE tenants SET features_custom = true WHERE 'full' = ANY(features);
