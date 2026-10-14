-- Central de Marketing: reanálise forçada ("Analisar agora" ou "Sincronizar") marca os anúncios para reler, sem apagar
-- a última análise (a tela segue mostrando o resultado salvo até cada anúncio ser relido).
ALTER TABLE listing_marketing ADD COLUMN stale boolean NOT NULL DEFAULT false;
