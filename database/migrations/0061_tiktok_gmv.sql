-- TikTok Shop: GMV como o Seller Center mostra (total pago pelo comprador em pedidos pagos, inclusive os cancelados
-- depois de pagos). Pedido cancelado que nunca foi pago deixa de ser importado; a próxima sincronização reimporta o
-- histórico, preenche o GMV e apaga os cancelados sem pagamento que já estavam no sistema.
ALTER TABLE orders ADD COLUMN gmv numeric(14,2);
UPDATE tiktok_connections SET backfilled = false;
