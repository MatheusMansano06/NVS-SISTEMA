import { z } from 'zod';

export const LISTING_TABS = ['active', 'paused', 'closed'] as const;
export type ListingTab = (typeof LISTING_TABS)[number];

export const listListingsSchema = z.object({
  status: z.enum(LISTING_TABS).default('active'),
  q: z.string().trim().max(120).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const setListingPriceSchema = z.object({ price: z.coerce.number().finite().positive().max(10_000_000) });
export const setListingStockSchema = z.object({ quantity: z.coerce.number().int().min(0).max(1_000_000) });
export const setListingStatusSchema = z.object({ status: z.enum(['active', 'paused', 'closed']) });

/** Margem unitária estimada de um anúncio (null = faltam dados para calcular). */
export interface ListingMarginDto {
  /** Tarifa de venda por unidade (já descontado o bônus do ML, quando houver). */
  fee: number | null;
  /** Frete pago pelo vendedor por unidade. */
  freight: number | null;
  cost: number | null;
  taxPct: number;
  tax: number;
  /** R$ por unidade vendida. */
  amount: number | null;
  /** Margem sobre o preço (0–1). */
  pct: number | null;
  /** De onde vieram tarifa e frete: média das vendas dos últimos 90 dias ou consulta ao ML. */
  source: 'sales' | 'live' | null;
}

export interface ListingDto {
  id: string;
  title: string;
  sku: string | null;
  pictureUrl: string | null;
  permalink: string | null;
  status: string;
  subStatus: string[];
  price: number | null;
  /** Preço cheio (riscado) quando o anúncio está com desconto. */
  originalPrice: number | null;
  /** R$ por venda que o ML devolve da tarifa na campanha ativa; nome da campanha. */
  feeBonus: number | null;
  promoName: string | null;
  stock: number | null;
  sold: number | null;
  /** Tipo do anúncio: 'Clássico' | 'Premium' | 'Grátis' | null. */
  type: string | null;
  freeShipping: boolean;
  logistic: 'full' | 'flex' | 'agency' | 'collect' | 'standard';
  picturesCount: number | null;
  /** Dimensões já formatadas (ex.: "27 x 20 x 13 cm · 305 g"). */
  dimensions: string | null;
  listedAt: string | null;
  catalog: boolean;
  /** Custo unitário cadastrado no Cadastro de SKUs. */
  cost: number | null;
  margin: ListingMarginDto;
  account: string;
}

export interface ListingListDto {
  items: ListingDto[];
  total: number;
  counts: Record<ListingTab, number>;
  /** Alíquota única de imposto da empresa (%). */
  taxPct: number;
  connected: boolean;
}

export interface ListingSaleDto {
  orderId: string;
  orderedAt: string;
  status: 'paid' | 'cancelled' | 'returned';
  quantity: number;
  unitPrice: number;
  gross: number;
  /** Rateados pela participação do item no pedido (pacotes com vários itens). */
  fee: number;
  freight: number;
  /** null = SKU sem custo cadastrado na data da venda. */
  margin: number | null;
}

export interface ListingMonthDto {
  /** AAAA-MM (fuso de São Paulo). */
  month: string;
  orders: number;
  units: number;
  gross: number;
  fee: number;
  freight: number;
  tax: number;
  cost: number | null;
  margin: number | null;
}

export interface ListingSalesDto {
  items: ListingSaleDto[];
  total: number;
  totals: { orders: number; units: number; gross: number };
}

/** Preço, tarifa e frete consultados ao vivo no marketplace. */
export interface ListingPricingDto {
  price: number;
  fee: number | null;
  feePct: number | null;
  freight: number | null;
  margin: ListingMarginDto;
  /** Tipo atual e a mesma conta nos dois tipos (Clássico × Premium). */
  type: string | null;
  options: { type: 'gold_special' | 'gold_pro'; label: string; fee: number; feePct: number | null; margin: ListingMarginDto }[];
}

export const listingTypeSchema = z.object({ type: z.enum(['gold_special', 'gold_pro']) });
export const duplicateListingSchema = z.object({
  categoryId: z.string().regex(/^MLB\d+$/).optional(),
  title: z.string().trim().min(3).max(120).optional(),
});

export interface CategoryOptionDto {
  id: string;
  name: string;
  domain: string | null;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Margem unitária (regra do NVS-WMS): preço − tarifa − frete − custo − imposto.
 * Imposto = preço × alíquota. Sem custo, tarifa ou frete a margem é desconhecida (nunca "zero").
 */
export function unitMargin(p: {
  price: number | null;
  fee: number | null;
  freight: number | null;
  cost: number | null;
  taxPct: number;
  source: 'sales' | 'live' | null;
}): ListingMarginDto {
  const tax = p.price ? round2((p.price * p.taxPct) / 100) : 0;
  const known = p.price !== null && p.price > 0 && p.fee !== null && p.freight !== null && p.cost !== null;
  const amount = known ? round2(p.price! - p.fee! - p.freight! - p.cost! - tax) : null;
  return {
    fee: p.fee,
    freight: p.freight,
    cost: p.cost,
    taxPct: p.taxPct,
    tax,
    amount,
    pct: amount !== null ? amount / p.price! : null,
    source: p.source,
  };
}

/** Faixa da margem: verde saudável (≥15%), âmbar atenção (≥8%), vermelho risco. */
export function marginTone(pct: number | null): 'ok' | 'warn' | 'bad' | 'none' {
  if (pct === null) return 'none';
  if (pct >= 0.15) return 'ok';
  if (pct >= 0.08) return 'warn';
  return 'bad';
}

// ================= Central de Promoção

/** Tipos em que o vendedor define o preço de oferta (deal_price). Os demais são só "aceitar". */
export const PRICED_PROMOTION_TYPES = ['DEAL', 'PRICE_DISCOUNT', 'DOD', 'LIGHTNING', 'PRE_NEGOTIATED'] as const;

export const PROMOTION_TYPE_LABEL: Record<string, string> = {
  DEAL: 'Campanha tradicional',
  PRICE_DISCOUNT: 'Desconto no preço',
  DOD: 'Oferta do dia',
  LIGHTNING: 'Oferta relâmpago',
  MARKETPLACE_CAMPAIGN: 'Campanha co-financiada',
  SELLER_CAMPAIGN: 'Campanha do vendedor',
  PRE_NEGOTIATED: 'Desconto pré-negociado',
  VOLUME: 'Desconto por volume',
  SMART: 'Campanha automática',
  UNHEALTHY_STOCK: 'Liquidação de estoque Full',
};

export interface PromotionDto {
  id: string;
  type: string;
  name: string;
  status: 'started' | 'pending';
  startDate: string | null;
  finishDate: string | null;
  /** Você define o preço de oferta (senão é só aceitar as condições do ML). */
  requiresPrice: boolean;
  connectionId: string;
  account: string;
}

export interface PromotionsDto {
  items: PromotionDto[];
  connected: boolean;
}

export interface PromotionCandidateDto {
  id: string;
  title: string;
  sku: string | null;
  pictureUrl: string | null;
  permalink: string | null;
  originalPrice: number | null;
  /** Preço que o ML aplica (promoções sem preço) ou sugere. */
  price: number | null;
  suggestedPrice: number | null;
  minPrice: number | null;
  maxPrice: number | null;
  /** % do desconto bancado pelo ML e pelo vendedor (campanhas co-financiadas). */
  meliPct: number | null;
  sellerPct: number | null;
  cost: number | null;
  /** Tarifa como fração do preço (estimada), para simular a margem no preço de oferta. */
  feeRate: number | null;
  freight: number | null;
  taxPct: number;
}

export interface PromotionCandidatesDto {
  items: PromotionCandidateDto[];
  total: number;
}

export const enrollPromotionSchema = z.object({
  promotionType: z.string().trim().min(1).max(40),
  dealPrice: z.coerce.number().finite().positive().max(10_000_000).optional(),
});

// ================= Editor do anúncio

export const PACKAGE_TYPES = ['Com embalagem adicional', 'Sem embalagem adicional'] as const;

export interface ListingEditorDto {
  id: string;
  title: string;
  sku: string | null;
  price: number | null;
  pictureUrl: string | null;
  permalink: string | null;
  logistic: ListingDto['logistic'];
  /** Full: dimensões medidas pelo ML e estoque gerido por ele. */
  full: boolean;
  catalog: boolean;
  description: string | null;
  /** Ficha técnica (sem os campos de embalagem, editados em Dimensões). */
  attributes: { id: string; name: string; value: string }[];
  pictures: { id: string; url: string }[];
  dimensions: { width: string; height: string; length: string; weight: string; packageType: string } | null;
  shippingTags: string[];
}

export interface WholesaleDto {
  standardPrice: number | null;
  /** Preço que um comprador empresa vê em cada quantidade. */
  sample: { quantity: number; price: number | null }[];
  active: boolean;
}

const measure = z.coerce.number().finite().positive().max(1000);
export const listingDescriptionSchema = z.object({ text: z.string().max(50_000) });
export const listingAttributesSchema = z.object({
  attributes: z.array(z.object({ id: z.string().regex(/^[A-Z0-9_]+$/), value: z.string().trim().max(255) })).max(300),
});
export const listingDimensionsSchema = z.object({
  width: measure,
  height: measure,
  length: measure,
  weight: z.coerce.number().int().positive().max(100_000),
  packageType: z.enum(PACKAGE_TYPES),
});
export const listingPicturesSchema = z.object({ pictureIds: z.array(z.string().min(1).max(80)).min(1).max(12) });
export const listingPictureUploadSchema = z.object({
  name: z.string().trim().min(1).max(120),
  type: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  /** Conteúdo em base64 (até ~10 MB). */
  data: z.string().min(1).max(14_000_000),
});
export const listingWholesaleSchema = z.object({
  tiers: z
    .array(z.object({ minUnits: z.coerce.number().int().min(2).max(10_000), price: z.coerce.number().finite().positive() }))
    .max(5),
});

// ================= Precificador

/** Tarifa de um tipo de anúncio num preço: % + parte fixa (o ML cobra fixo abaixo de ~R$ 79). */
export interface FeeQuoteDto {
  type: 'gold_special' | 'gold_pro';
  label: string;
  fee: number;
  feePct: number | null;
  fixedFee: number;
}

export interface PricingQuoteDto {
  price: number;
  categoryId: string | null;
  fees: FeeQuoteDto[];
}

export const pricingQuoteSchema = z.object({
  price: z.coerce.number().finite().positive().max(10_000_000),
  categoryId: z.string().regex(/^MLB\d+$/).optional(),
});

/**
 * Preço que entrega a margem alvo: preço = (custo + frete + fixo) / (1 − %tarifa − %imposto − %alvo).
 * Aproximação (o frete e o fixo podem mudar de faixa no novo preço) — confirme com a tarifa real.
 */
export function priceForMargin(p: { targetPct: number; feePct: number; fixedFee: number; freight: number; cost: number; taxPct: number }): number | null {
  const denom = 1 - p.feePct / 100 - p.taxPct / 100 - p.targetPct / 100;
  if (denom <= 0.01) return null;
  return Math.ceil(((p.cost + p.freight + p.fixedFee) / denom) * 100) / 100;
}

export const savePricingSimulationSchema = z.object({
  listingId: z.string().regex(/^[A-Z]{3}\d+$/).optional(),
  title: z.string().trim().min(1).max(200),
  sku: z.string().trim().max(120).optional(),
  listingType: z.enum(['gold_special', 'gold_pro']),
  price: z.coerce.number().finite().positive(),
  cost: z.coerce.number().finite().min(0).nullable(),
  freight: z.coerce.number().finite().min(0),
  taxPct: z.coerce.number().min(0).max(100),
  fee: z.coerce.number().finite().min(0),
});

export interface PricingSimulationDto {
  id: string;
  listingId: string | null;
  title: string;
  sku: string | null;
  listingType: 'gold_special' | 'gold_pro';
  price: number;
  cost: number | null;
  freight: number;
  taxPct: number;
  fee: number;
  margin: number | null;
  marginPct: number | null;
  createdAt: string;
  /** Preço atual do anúncio (para ver se a simulação já foi aplicada). */
  currentPrice: number | null;
}

// ================= Categorias (simulação livre)

export interface CategoryNodeDto {
  id: string;
  name: string;
  /** null = ainda não sabemos (abre para descobrir). */
  leaf: boolean | null;
  /** % de tarifa no Clássico e no Premium (preço de referência R$ 100). */
  feeClassic: number | null;
  feePremium: number | null;
}

export interface CategoryLevelDto {
  path: { id: string; name: string }[];
  items: CategoryNodeDto[];
}

export interface CategoryInfoDto extends CategoryNodeDto {
  path: { id: string; name: string }[];
  /** Tamanho médio do pacote nesta categoria (cm / g), para pré-preencher. */
  dims: { height: number; width: number; length: number; weight: number } | null;
}

/** Abaixo deste preço o frete grátis não é obrigatório no Brasil (Mercado Envios). */
export const FREE_SHIPPING_MIN_PRICE = 79;

export const freightQuoteSchema = z.object({
  price: z.coerce.number().finite().positive(),
  type: z.enum(['gold_special', 'gold_pro']),
  height: z.coerce.number().positive().max(300),
  width: z.coerce.number().positive().max(300),
  length: z.coerce.number().positive().max(300),
  weight: z.coerce.number().int().positive().max(100_000),
  categoryId: z.string().regex(/^MLB\d+$/).optional(),
});

export interface FreightQuoteDto {
  /** Frete pago pelo vendedor; 0 quando o comprador paga. */
  freight: number;
  freeShipping: boolean;
  /** 'ml' = calculado pelo Mercado Livre com a reputação da conta; 'none' = comprador paga. */
  source: 'ml' | 'none';
}
