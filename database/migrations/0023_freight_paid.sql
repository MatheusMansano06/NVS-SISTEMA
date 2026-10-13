-- Frete que o ML cobra de fato do vendedor (senders.cost em /shipments/{id}/costs, já com o desconto de
-- reputação), em vez da tabela (list_cost). Guarda a tabela para medir o desconto de cada anúncio.
ALTER TABLE orders ADD COLUMN shipping_list_cost numeric(14, 2);
ALTER TABLE orders ADD COLUMN freight_checked_at timestamptz;
-- desconto médio no frete por anúncio (pago ÷ tabela, vendas de 90 dias); null = sem vendas conferidas
ALTER TABLE listings ADD COLUMN freight_paid_ratio numeric(6, 4);
