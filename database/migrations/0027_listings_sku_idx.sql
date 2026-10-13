-- Foto do produto na separação/Master Data: busca do anúncio pelo SKU sem diferenciar maiúsculas.
CREATE INDEX IF NOT EXISTS listings_upper_sku_idx ON listings (tenant_id, upper(sku));
