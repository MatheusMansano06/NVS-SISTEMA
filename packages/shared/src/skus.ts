import { z } from 'zod';

const money = z.coerce.number().finite().positive('O custo precisa ser maior que zero').max(10_000_000);

export const saveSkuCostSchema = z.object({
  sku: z.string().trim().min(1).max(120),
  custoUnit: money,
});
export type SaveSkuCostInput = z.infer<typeof saveSkuCostSchema>;

export const SKU_FILTERS = ['all', 'missing', 'done'] as const;
export type SkuFilter = (typeof SKU_FILTERS)[number];

export const listSkusSchema = z.object({
  q: z.string().trim().max(120).optional(),
  filter: z.enum(SKU_FILTERS).default('all'),
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const importSkusSchema = z.object({
  csv: z.string().min(1).max(2_000_000),
  dryRun: z.boolean().default(true),
});


export interface SkuRowDto {
  sku: string;
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
  invalidRows: { line: number; sku: string | null; reason: string }[];
}
