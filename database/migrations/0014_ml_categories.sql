-- Cache GLOBAL das categorias do Mercado Livre (dado público do site MLB, igual para todas as empresas):
-- caminho, se é folha, % de tarifa por tipo e o tamanho médio do pacote. Atualizado a cada 7 dias.
CREATE TABLE ml_categories (
  category_id   text PRIMARY KEY,
  name          text NOT NULL,
  parent_id     text,
  path          jsonb NOT NULL DEFAULT '[]',      -- [{id, name}] da raiz até a categoria
  leaf          boolean,
  fee_classic   numeric(5, 2),                    -- % Clássico (gold_special)
  fee_premium   numeric(5, 2),                    -- % Premium (gold_pro)
  dims          jsonb,                            -- {height, width, length, weight} médios da categoria
  fetched_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ml_categories_parent_idx ON ml_categories (parent_id);
