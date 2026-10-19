-- Viabilidade: categoria do ML escolhida na lista (com as tarifas Clássico/Premium) e o tipo de anúncio.
ALTER TABLE pricing_studies
  ADD COLUMN category_id   text,
  ADD COLUMN category_name text,
  ADD COLUMN fee_classic   numeric(5, 2),
  ADD COLUMN fee_premium   numeric(5, 2),
  ADD COLUMN listing_type  text CHECK (listing_type IN ('gold_special', 'gold_pro'));
