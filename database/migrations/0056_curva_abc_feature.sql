-- Curva ABC vira um recurso próprio no Painel Master. Quem já tinha Vendas continua vendo a Curva ABC;
-- empresa e plano novos nascem com ela.
UPDATE tenants SET features = array_append(features, 'curva_abc') WHERE 'vendas' = ANY(features) AND NOT 'curva_abc' = ANY(features);
UPDATE plans SET features = array_append(features, 'curva_abc') WHERE 'vendas' = ANY(features) AND NOT 'curva_abc' = ANY(features);
ALTER TABLE tenants ALTER COLUMN features
  SET DEFAULT ARRAY['financeiro', 'dre', 'curva_abc', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
ALTER TABLE plans ALTER COLUMN features
  SET DEFAULT ARRAY['financeiro', 'dre', 'curva_abc', 'vendas', 'anuncios', 'promocoes', 'marketing', 'precificador', 'radar_frete', 'devolucoes'];
