import { z } from 'zod';
import { MARKETPLACES, type Marketplace } from './onboarding.js';

const money = z.coerce.number().finite().positive('O custo precisa ser maior que zero').max(10_000_000);

export const saveSkuCostSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  custoUnit: money,
  /**
   * Desde quando o custo vale: 'sempre' (todas as vendas) ou um dia (AAAA-MM-DD, até hoje). Substitui as alterações
   * feitas a partir dessa data. Ausente = regra padrão (primeiro custo vale sempre; mudança vale a partir de hoje).
   */
  vigenteDesde: z.union([z.literal('sempre'), z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Data inválida.')]).optional(),
});
export type SaveSkuCostInput = z.infer<typeof saveSkuCostSchema>;

export const SKU_FILTERS = ['all', 'missing', 'done'] as const;
export type SkuFilter = (typeof SKU_FILTERS)[number];

export const listSkusSchema = z.object({
  q: z.string().trim().max(120).optional(),
  filter: z.enum(SKU_FILTERS).default('all'),
  /** Só os SKUs que existem (anúncio ou venda recente) nesta plataforma. */
  platform: z.enum(MARKETPLACES).optional(),
  /** Relê anúncios e vendas agora (a lista normalmente vem de uma base guardada por alguns minutos). */
  fresh: z.coerce.boolean().optional(),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const importSkusSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
  /** Importa só os SKUs que existem nos anúncios/vendas e pula os outros (em vez de barrar a planilha). */
  ignoreUnknown: z.boolean().default(false),
});


/** Vincula um SKU ao SKU do mesmo produto em outra plataforma: passa a usar o custo dele. */
export const linkSkuSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  linkedSku: z.string().trim().min(1).max(120),
});

export interface SkuRowDto {
  sku: string;
  /** Plataformas em que o SKU existe (anúncio ativo ou venda nos últimos 90 dias). */
  platforms: Marketplace[];
  /** SKU de outra plataforma ao qual este está vinculado (o custo mostrado é o dele). */
  linkedSku: string | null;
  title: string | null;
  pictureUrl: string | null;
  permalink: string | null;
  listingStatus: string | null;
  stock: number | null;
  units30d: number;
  avgPrice: number | null;
  custoUnit: number | null;
  updatedAt: string | null;
}

export interface SkuListDto {
  items: SkuRowDto[];
  total: number;
  counts: { all: number; done: number; missing: number };
}

export interface SkuImportReport {
  status: 'dry_run' | 'ok' | 'rejected';
  received: number;
  created: number;
  updated: number;
  unchanged: number;
  /** Linhas com custo vazio ou zero: aceitas, o SKU fica "sem custo" no cadastro. */
  withoutCost: number;
  /** SKUs que não existem em nenhum anúncio nem venda do marketplace (barram a planilha, a não ser que se peça para pular). */
  unknownSkus: { line: number; sku: string }[];
  /** SKUs desconhecidos que foram pulados (com "importar só os que existem"). */
  ignored: number;
  /** Linhas repetidas (mesmo SKU, mesmo que com outra caixa de letra): fica a primeira, as outras são puladas. */
  duplicates: { line: number; sku: string; keptLine: number }[];
  invalidRows: { line: number; sku: string | null; reason: string }[];
}
