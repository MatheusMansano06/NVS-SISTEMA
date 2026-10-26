-- Radar ADS: a primeira leitura caiu nas métricas básicas (sem orgânico e unidades); relê os 90 dias na próxima atualização
UPDATE ad_accounts SET metrics_backfilled_at = NULL WHERE metrics_backfilled_at IS NOT NULL;
