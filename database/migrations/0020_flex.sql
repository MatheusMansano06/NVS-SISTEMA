-- Flex por anúncio (tag self_service_in) e localização do comprador (para cruzar com a área de Flex).
ALTER TABLE listings ADD COLUMN flex_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE orders ADD COLUMN ship_lat numeric(9, 6);
ALTER TABLE orders ADD COLUMN ship_lng numeric(9, 6);
-- envios já consultados antes de guardarmos a localização: consulta de novo (em segundo plano)
UPDATE orders SET address_checked_at = NULL WHERE address_checked_at IS NOT NULL AND ship_lat IS NULL AND shipping_ref IS NOT NULL;
