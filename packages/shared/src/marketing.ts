/** Central de Marketing: quanto dos anúncios ativos usa cada ferramenta do Mercado Livre, por conta. */

/** Ferramentas medidas anúncio a anúncio. */
export const MARKETING_TOOLS = [
  'wholesale',
  'clips',
  'video',
  'ads',
  'coupon',
  'volume',
  'price_discount',
  'lightning',
  'dod',
  'deal',
  'co_funded',
] as const;
export type MarketingTool = (typeof MARKETING_TOOLS)[number];

export const MARKETING_TOOL_INFO: Record<MarketingTool, { label: string; hint: string; promoTypes?: string[] }> = {
  wholesale: { label: 'Preço de atacado', hint: 'Faixas de preço por quantidade para compradores empresa.' },
  clips: { label: 'Clips', hint: 'Vídeos curtos publicados no anúncio.' },
  video: { label: 'Vídeo no anúncio', hint: 'Vídeo cadastrado na ficha do anúncio.' },
  ads: { label: 'Mercado Ads', hint: 'Anúncio patrocinado ativo no Product Ads.' },
  coupon: { label: 'Cupom', hint: 'Cupom do vendedor no anúncio, na loja inteira ou para seguidores.', promoTypes: ['SELLER_COUPON_CAMPAIGN'] },
  volume: { label: 'Desconto por quantidade', hint: 'Desconto comprando 2 ou mais unidades.', promoTypes: ['VOLUME'] },
  price_discount: { label: 'Desconto no preço', hint: 'Desconto por porcentagem definido por você.', promoTypes: ['PRICE_DISCOUNT', 'SELLER_CAMPAIGN'] },
  lightning: { label: 'Oferta relâmpago', hint: 'Promoção que dura poucas horas.', promoTypes: ['LIGHTNING'] },
  dod: { label: 'Oferta do dia', hint: 'Destaque por um dia.', promoTypes: ['DOD'] },
  deal: { label: 'Campanhas do ML', hint: 'Campanhas tradicionais do Mercado Livre.', promoTypes: ['DEAL'] },
  co_funded: {
    label: 'Desconto co-financiado',
    hint: 'O ML banca parte do desconto e reduz a tarifa.',
    promoTypes: ['MARKETPLACE_CAMPAIGN', 'SMART', 'PRE_NEGOTIATED', 'UNHEALTHY_STOCK'],
  },
};

export interface MarketingToolStat {
  tool: MarketingTool;
  /** Anúncios usando a ferramenta. */
  using: number;
  /** Anúncios sem a ferramenta (dos já analisados com leitura disponível). */
  notUsing: number;
  /** Dos que não usam, quantos o ML já aponta como elegíveis (candidatos). */
  eligible: number;
  /** false = o ML não informou para esta conta (ferramenta indisponível ou sem permissão). */
  available: boolean;
}

export interface MarketingAccountDto {
  connectionId: string;
  accountId: string;
  nickname: string;
  activeListings: number;
  analyzed: number;
  /** Na fila para (re)ler: novos, marcados pelo "Analisar agora"/"Sincronizar" ou com mais de uma semana. */
  pending: number;
  lastCheckedAt: string | null;
  tools: MarketingToolStat[];
  /** Campanhas abertas para a conta agora, por tipo (o que o ML oferece a esta conta). */
  openCampaigns: { type: string; count: number }[];
}

export interface MarketingDto {
  accounts: MarketingAccountDto[];
  scanning: boolean;
}

export interface MarketingListingDto {
  id: string;
  title: string;
  pictureUrl: string | null;
  permalink: string | null;
  price: number | null;
  sku: string | null;
  eligible: boolean;
}
