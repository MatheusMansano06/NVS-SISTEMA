-- Radar ADS: motivo da última leitura de métricas que falhou (a tela mostra em vez de "primeira leitura em andamento")
ALTER TABLE ad_accounts ADD COLUMN metrics_error text;
