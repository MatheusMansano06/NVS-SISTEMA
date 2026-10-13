-- Anúncios em promoção: preço cheio (riscado) e bônus de tarifa que o ML banca na campanha ativa.
ALTER TABLE listings ADD COLUMN original_price numeric(14, 2);  -- só quando maior que o preço atual
ALTER TABLE listings ADD COLUMN fee_bonus numeric(14, 2);       -- R$ por venda devolvidos pelo ML (meli_percentage)
ALTER TABLE listings ADD COLUMN promo_name text;
