/** O que cada sigla do Radar significa, em linguagem simples (aparece no "?" ao lado do termo). */
export const GLOSSARY = {
  TACOS:
    'TACOS (Total Advertising Cost of Sales): investimento em Ads ÷ receita bruta × 100. Usa todas as vendas, com e sem Ads. Mostra quanto os Ads pesam no faturamento total.',
  ACOS:
    'ACOS (Advertising Cost of Sales): investimento em Ads ÷ vendas atribuídas aos Ads × 100. Quanto você gastou em Ads para cada R$ 100 vendidos pelos anúncios patrocinados.',
  ROAS: 'ROAS (Return on Ad Spend): vendas atribuídas aos Ads ÷ investimento. 20x = cada R$ 1 investido voltou R$ 20 em vendas.',
  investimento: 'Quanto o Mercado Ads cobrou no período (o custo dos cliques nos anúncios patrocinados).',
  vendasAds:
    'Vendas que o Mercado Livre atribui aos anúncios patrocinados: diretas (o anúncio clicado) e indiretas (outro produto seu comprado depois do clique).',
  receita: 'Soma dos pedidos pagos no Mercado Livre no período, antes de tarifas, frete, custo e imposto. Mesma base do Dashboard.',
  margemAntes:
    'Lucro ÷ receita bruta, com lucro = receita − tarifas − frete − custo do produto − imposto. Sem custo cadastrado no SKU, ela aparece maior do que é.',
  margemPos: 'Margem antes dos Ads − TACOS: o que sobra de cada R$ 100 vendidos depois de pagar os Ads.',
  alvo: 'ACOS objetivo configurado na própria campanha dentro do Mercado Ads.',
  semAds: 'Receita dos pedidos que não veio dos anúncios patrocinados (venda orgânica).',
} as const;
