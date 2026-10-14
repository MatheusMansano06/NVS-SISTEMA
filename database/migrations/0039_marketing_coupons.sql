-- Central de Marketing: cupons da conta (loja inteira e seguidores) passam a contar; relê todos os anúncios.
UPDATE listing_marketing SET stale = true;
