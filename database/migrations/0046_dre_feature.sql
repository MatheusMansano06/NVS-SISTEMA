-- DRE vira um recurso próprio no Painel Master. Quem já tinha a Análise Financeira continua vendo o DRE;
-- empresa e plano novos nascem com ele.
UPDATE tenants SET features = array_append(features, 'dre') WHERE 'financeiro' = ANY(features) AND NOT 'dre' = ANY(features);
UPDATE plans SET features = array_append(features, 'dre') WHERE 'financeiro' = ANY(features) AND NOT 'dre' = ANY(features);
ALTER TABLE tenants ALTER COLUMN features
  SET DEFAULT ARRAY['financeiro', 'dre', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
ALTER TABLE plans ALTER COLUMN features
  SET DEFAULT ARRAY['financeiro', 'dre', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
