import { z } from 'zod';

/**
 * Radar de Produtos: o agente de viabilidade (Claude no Chrome com o Avantpro) estuda os mais vendidos de uma categoria
 * e grava aqui cada produto com os anúncios que analisou. A tela mostra o ranking do dia e o campeão.
 *   Anúncio aprovado = vende 1+/dia (vendas estimadas ÷ dias de vida) E tem avaliações quase todo dia.
 */

export const PRODUCT_RADAR_VERDICTS = ['viavel', 'arriscado', 'inviavel'] as const;
export type ProductRadarVerdict = (typeof PRODUCT_RADAR_VERDICTS)[number];
export const PRODUCT_RADAR_VERDICT_LABELS: Record<ProductRadarVerdict, string> = { viavel: 'Viável', arriscado: 'Arriscado', inviavel: 'Inviável' };

const nullableNumber = z.number().finite().nonnegative().nullable().default(null);

export const productRadarListingSchema = z.object({
  title: z.string().trim().min(1).max(300),
  link: z.string().url().max(1000).nullable().default(null),
  thumbnail: z.string().url().max(1000).nullable().default(null),
  kind: z.enum(['produto', 'catalogo']).default('produto'),
  price: nullableNumber,
  ageDays: z.number().int().nonnegative().nullable().default(null),
  estSales: z.number().int().nonnegative().nullable().default(null),
  salesPerDay: nullableNumber,
  monthlyPace: z.number().int().nonnegative().nullable().default(null),
  reviewDays7d: z.number().int().min(0).max(8).nullable().default(null),
  reviews7d: z.number().int().nonnegative().nullable().default(null),
  passSales: z.boolean(),
  passReviews: z.boolean(),
  note: z.string().trim().max(300).nullable().default(null),
});
export type ProductRadarListing = z.infer<typeof productRadarListingSchema>;

export const productRadarProductSchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  mode: z.enum(['diario', 'avulso']).default('diario'),
  category: z.string().trim().max(200).nullable().default(null),
  search: z.string().trim().min(1).max(200),
  sourceTitle: z.string().trim().max(300).nullable().default(null),
  verdict: z.enum(PRODUCT_RADAR_VERDICTS),
  note: z.string().trim().max(500).nullable().default(null),
  listings: z.array(productRadarListingSchema).min(1).max(12),
});
export type ProductRadarProductInput = z.input<typeof productRadarProductSchema>;

export interface ProductRadarProductDto {
  id: string;
  day: string;
  mode: 'diario' | 'avulso';
  category: string | null;
  search: string;
  sourceTitle: string | null;
  verdict: ProductRadarVerdict;
  note: string | null;
  analyzed: number;
  passSales: number;
  passReviews: number;
  approved: number;
  /** Maior vendas/dia entre os anúncios aprovados (0 se nenhum). */
  leaderSalesPerDay: number;
  thumbnail: string | null;
  listings: (ProductRadarListing & { approved: boolean })[];
  createdAt: string;
}

export interface ProductRadarDayDto {
  day: string | null;
  /** Dias com estudo gravado, do mais recente para o mais antigo (até 30). */
  days: { day: string; products: number; viable: number }[];
  /** Produtos do dia já em ordem de ranking (o primeiro é o campeão). */
  products: ProductRadarProductDto[];
}

/** Resumo de um produto a partir dos anúncios: contagens, líder e foto de capa (a do líder). */
export function summarizeProductRadar(listings: readonly ProductRadarListing[]) {
  const rows = listings.map((l) => ({ ...l, approved: l.passSales && l.passReviews }));
  const approved = rows.filter((l) => l.approved);
  const leader = [...(approved.length ? approved : rows)].sort((a, b) => (b.salesPerDay ?? 0) - (a.salesPerDay ?? 0))[0];
  return {
    listings: rows,
    analyzed: rows.length,
    passSales: rows.filter((l) => l.passSales).length,
    passReviews: rows.filter((l) => l.passReviews).length,
    approved: approved.length,
    leaderSalesPerDay: approved.length ? (leader?.salesPerDay ?? 0) : 0,
    thumbnail: leader?.thumbnail ?? rows.find((l) => l.thumbnail)?.thumbnail ?? null,
  };
}

const VERDICT_RANK: Record<ProductRadarVerdict, number> = { viavel: 0, arriscado: 1, inviavel: 2 };

/** Ranking do dia: veredito, depois quantos anúncios aprovados, depois o líder em vendas/dia. */
export function compareProductRadar(
  a: Pick<ProductRadarProductDto, 'verdict' | 'approved' | 'leaderSalesPerDay'>,
  b: Pick<ProductRadarProductDto, 'verdict' | 'approved' | 'leaderSalesPerDay'>,
): number {
  return VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict] || b.approved - a.approved || b.leaderSalesPerDay - a.leaderSalesPerDay;
}
