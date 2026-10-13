-- Média de tarifa e frete por unidade (vendas de 1 item dos últimos 90 dias) guardada no anúncio:
-- calculada na sincronização, em vez de a cada abertura da aba Anúncios.
ALTER TABLE listings ADD COLUMN sales_fee_avg numeric(14, 4);
ALTER TABLE listings ADD COLUMN sales_freight_avg numeric(14, 4);
-- busca de SKU nas variações (Cadastro de SKUs)
CREATE INDEX listings_variation_skus_idx ON listings USING gin (variation_skus);
