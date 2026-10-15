-- Recursos liberados por empresa (o Painel Master liga/desliga). Supervisão Full ("full") começa só na empresa piloto.
ALTER TABLE tenants ADD COLUMN features text[] NOT NULL DEFAULT '{}';
UPDATE tenants SET features = ARRAY['full'] WHERE cnpj = '06226411000186';
