-- TikTok Shop: live em que a venda aconteceu (room_id do item do pedido; vazio = fora de live: vídeo, vitrine, card).
ALTER TABLE orders ADD COLUMN live_room_id text;
CREATE INDEX orders_live_room_idx ON orders (tenant_id, live_room_id) WHERE live_room_id IS NOT NULL;
-- a próxima sincronização reimporta o histórico dos pedidos para preencher a live (os extratos não são relidos)
UPDATE tiktok_connections SET backfilled = false;
