-- DRE: o que sobrou das vendas fora do Mercado Livre (TikTok Shop, Shopee…), lançado à mão. Soma no resultado.
ALTER TABLE dre_entries DROP CONSTRAINT dre_entries_kind_check;
ALTER TABLE dre_entries ADD CONSTRAINT dre_entries_kind_check
  CHECK (kind IN ('custo_variavel', 'despesa_fixa', 'despesa_financeira', 'outra_plataforma'));
ALTER TABLE dre_entries DROP CONSTRAINT dre_entries_category_check;
ALTER TABLE dre_entries ADD CONSTRAINT dre_entries_category_check
  CHECK (category IN ('pessoas', 'estrutura', 'sistemas', 'servicos', 'marketing', 'logistica', 'financeiro', 'outros', 'plataformas'));
ALTER TABLE dre_entries ADD CONSTRAINT dre_entries_outra_plataforma_basis_check
  CHECK (kind <> 'outra_plataforma' OR basis IN ('mensal', 'unico'));
