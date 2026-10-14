-- Central de Marketing: a leitura do preço de atacado passou a consultar o preço para empresa; relê todos os anúncios.
UPDATE listing_marketing SET stale = true;
