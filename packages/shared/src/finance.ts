import { z } from 'zod';
import { MARKETPLACES } from './onboarding.js';

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida (AAAA-MM-DD)');

export const LOGISTIC_BUCKETS = ['full', 'flex', 'places_coleta', 'me1', 'outros'] as const;
export type LogisticBucketId = (typeof LOGISTIC_BUCKETS)[number];
export const LOGISTIC_LABELS: Record<LogisticBucketId, string> = {
  full: 'Full',
  flex: 'Flex',
  places_coleta: 'Coleta',
  me1: 'ME1',
  outros: 'A combinar',
};

export const SALE_STATUSES = ['aprovada', 'cancelada', 'devolucao'] as const;
export type SaleStatus = (typeof SALE_STATUSES)[number];

/** Faixas de margem do NVS-WMS: bom ≥ 13%, atenção 10–13%, crítico < 10%. */
export const MARGIN_BANDS = ['bom', 'atencao', 'critico'] as const;
export type MarginBand = (typeof MARGIN_BANDS)[number];
export const marginBand = (mcPct: number): MarginBand => (mcPct >= 13 ? 'bom' : mcPct >= 10 ? 'atencao' : 'critico');

export const financeQuerySchema = z
  .object({
    from: isoDate,
    to: isoDate,
    marketplace: z.enum(MARKETPLACES).optional(),
    accountId: z.string().uuid().optional(),
    /** NVS-WMS: soma o frete comprador na base da MC em todas as modalidades. */
    considerarFreteComprador: z.coerce.boolean().optional(),
    fresh: z.coerce.boolean().optional(),
  })
  .refine((q) => q.from <= q.to, { message: 'A data inicial deve ser antes da final', path: ['from'] })
  .refine((q) => (Date.parse(q.to) - Date.parse(q.from)) / 86_400_000 <= 366, {
    message: 'Período máximo de 1 ano',
    path: ['to'],
  });
export type FinanceQuery = z.infer<typeof financeQuerySchema>;

/** Modalidade do anúncio no ML. */
export const LISTING_TYPE_LABELS: Record<string, string> = {
  gold_special: 'Clássico',
  gold_pro: 'Premium',
  gold_premium: 'Diamante',
  gold: 'Ouro',
  silver: 'Prata',
  bronze: 'Bronze',
  free: 'Grátis',
};

/** TikTok Shop não tem modalidade de frete nem tipo de anúncio: a tela mostra quem faz o envio. */
export const TIKTOK_SHIPPING_LABELS: Record<string, string> = {
  tiktok_tiktok: 'Enviado pela plataforma',
  tiktok_seller: 'Enviado pelo vendedor',
};

export const COST_FILTERS = ['com_custo', 'sem_custo'] as const;

export const financeLinesQuerySchema = z.object({
  status: z.enum(SALE_STATUSES).optional(),
  bucket: z.enum(LOGISTIC_BUCKETS).optional(),
  listingType: z.string().trim().max(40).optional(),
  custo: z.enum(COST_FILTERS).optional(),
  /** compat: equivale a custo=sem_custo */
  semCusto: z.coerce.boolean().optional(),
  margem: z.enum(MARGIN_BANDS).optional(),
  sku: z.string().trim().max(120).optional(),
  pedido: z.string().trim().max(60).optional(),
  q: z.string().trim().max(120).optional(),
  /** ordenação pela margem de contribuição % (sem custo vai para o fim); ausente = ordem padrão */
  ordem: z.enum(['mc_desc', 'mc_asc']).optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type FinanceLinesQuery = z.infer<typeof financeLinesQuerySchema>;

export interface FinanceCards {
  vendasAprovadas: number;
  vendasCanceladas: number;
  devolucoesParciais: number;
  faturamento: number;
  custoTotal: number | null;
  impostoTotal: number | null;
  tarifa: number;
  freteComprador: number;
  freteVendedor: number;
  cupomSeller: number;
  mcTotal: number | null;
  mcPct: number | null;
  ticketMedio: number;
  ticketMc: number | null;
  qtdAprovadas: number;
  qtdCanceladas: number;
  qtdDevolucoes: number;
  unidades: number;
}

export interface FinanceSummaryDto {
  range: { from: string; to: string };
  cards: FinanceCards;
  /** Composição sobre a base da MC (vendas aprovadas com custo). */
  composicao: { key: 'custo' | 'imposto' | 'tarifa' | 'frete' | 'ads' | 'mc'; label: string; valor: number; pct: number }[];
  series: { day: string; aprovadas: number; mc: number | null }[];
  semCusto: { qtd: number; valor: number; skus: string[] };
  breakdown: { bucket: LogisticBucketId; valor: number }[];
  /** Investido em Mercado Ads no período (mesma fonte do Dashboard); a tela decide se desconta da MC. */
  adSpend: number;
  freteIncerto: number;
  enriquecimentoPendente: number;
  generatedAt: string;
}

export interface FinanceLineDto {
  orderId: string;
  listingId: string | null;
  listingType: string | null;
  date: string;
  status: SaleStatus;
  bucket: LogisticBucketId;
  sku: string;
  title: string;
  pictureUrl: string | null;
  valorUnit: number;
  qtd: number;
  faturamento: number;
  cupom: number;
  custo: number | null;
  imposto: number | null;
  tarifa: number;
  freteComprador: number;
  freteVendedor: number;
  mc: number | null;
  mcPct: number | null;
}

export interface FinanceLinesDto {
  items: FinanceLineDto[];
  total: number;
}

export const taxRateSchema = z.object({
  ratePct: z.coerce.number().finite().min(0).max(100),
  /** Vale desde (AAAA-MM-DD, até hoje): recalcula as vendas a partir desse dia. Ausente = regra padrão (a partir de hoje). */
  vigenteDesde: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.').optional(),
});
export interface TaxRateDto {
  ratePct: number | null;
  vigenteDesde: string | null;
}

/** Alerta de margem baixa (Dashboard): margem mínima da empresa, de 0 a 100%. */
export const DEFAULT_LOW_MARGIN_PCT = 8;
export const lowMarginSettingsSchema = z.object({ pct: z.coerce.number().min(-100).max(100) });

export interface LowMarginSaleDto {
  orderId: string;
  date: string;
  title: string;
  sku: string;
  pictureUrl: string | null;
  bucket: LogisticBucketId;
  faturamento: number;
  mc: number;
  mcPct: number;
}

export interface LowMarginDto {
  minPct: number;
  /** Vendas aprovadas com custo e margem abaixo do mínimo (as piores primeiro). */
  items: LowMarginSaleDto[];
  total: number;
  /** Quanto a mais teria sobrado se todas tivessem batido o mínimo. */
  gap: number;
  /** Vendas aprovadas sem custo cadastrado (ficam fora do alerta). */
  semCusto: number;
}

/** Simulador de imposto: alíquota "de" → "para" (padrão: a anterior e a atual da empresa). */
export const taxImpactQuerySchema = z.object({
  de: z.coerce.number().min(0).max(100).optional(),
  para: z.coerce.number().min(0).max(100).optional(),
});

export interface TaxImpactItemDto {
  sku: string;
  title: string;
  pictureUrl: string | null;
  unidades: number;
  vendas: number;
  /** Produto − cupom: base do imposto. */
  faturamento: number;
  mcAntes: number;
  mcDepois: number;
  mcPctAntes: number;
  mcPctDepois: number;
  /** mcDepois − mcAntes (negativo quando o imposto sobe). */
  impacto: number;
  /** Preço médio de venda por unidade no período. */
  precoMedio: number;
  /** Preço por unidade para voltar à margem % de antes com a alíquota nova (null se nenhum preço chega). */
  precoSugerido: number | null;
}

export interface TaxImpactDto {
  de: number;
  para: number;
  /** Alíquota vigente da empresa (null se nunca cadastrada). */
  atual: number | null;
  resumo: { faturamento: number; mcAntes: number; mcDepois: number; produtos: number; viraramPrejuizo: number };
  items: TaxImpactItemDto[];
  /** Vendas aprovadas sem custo (ficam fora da simulação). */
  semCusto: number;
}
