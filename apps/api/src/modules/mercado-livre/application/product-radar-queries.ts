import {
  compareProductRadar, summarizeProductRadar, productRadarProductSchema,
  type ProductRadarDayDto, type ProductRadarProductDto, type ProductRadarListing,
} from '@nvs/shared';
import type { z } from 'zod';
import type { Database } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { todayIn } from '../../sales/index.js';

class FeatureLockedError extends AppError {
  constructor() {
    super('O Produto Campeão ainda não está liberado para a sua empresa.', 'FEATURE_LOCKED', 403);
  }
}

interface ProductRow {
  id: string;
  day: string;
  mode: ProductRadarProductDto['mode'];
  category: string | null;
  search: string;
  source_title: string | null;
  verdict: ProductRadarProductDto['verdict'];
  note: string | null;
  analyzed: number;
  pass_sales: number;
  pass_reviews: number;
  approved: number;
  leader_sales_per_day: string;
  thumbnail: string | null;
  listings: ProductRadarProductDto['listings'];
  created_at: Date;
}

const toDto = (r: ProductRow): ProductRadarProductDto => ({
  id: r.id,
  day: r.day,
  mode: r.mode,
  category: r.category,
  search: r.search,
  sourceTitle: r.source_title,
  verdict: r.verdict,
  note: r.note,
  analyzed: r.analyzed,
  passSales: r.pass_sales,
  passReviews: r.pass_reviews,
  approved: r.approved,
  leaderSalesPerDay: Number(r.leader_sales_per_day),
  thumbnail: r.thumbnail,
  listings: r.listings,
  createdAt: r.created_at.toISOString(),
});

/** Produto Campeão: grava o estudo de cada produto feito pelo agente e monta o ranking do dia. */
export class ProductRadarQueries {
  constructor(private readonly db: Database) {}

  async ensureFeature(tenantId: string): Promise<void> {
    const r = await this.db.query<{ ok: boolean }>(`SELECT 'radar_produtos' = ANY(features) AS ok FROM tenants WHERE id = $1`, [tenantId]);
    if (!r.rows[0]?.ok) throw new FeatureLockedError();
  }

  /** Ranking de um dia (padrão: o último dia com estudo). */
  async day(tenantId: string, day?: string): Promise<ProductRadarDayDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const days = (
        await db.query<{ day: string; products: number; viable: number }>(
          `SELECT day::text, count(*)::int AS products, count(*) FILTER (WHERE verdict = 'viavel')::int AS viable
             FROM product_radar_products GROUP BY day ORDER BY day DESC LIMIT 30`,
        )
      ).rows;
      const pick = day ?? days[0]?.day ?? null;
      if (!pick) return { day: null, days, products: [] };
      const rows = (await db.query<ProductRow>(`SELECT *, day::text FROM product_radar_products WHERE day = $1`, [pick])).rows;
      return { day: pick, days, products: rows.map(toDto).sort(compareProductRadar) };
    });
  }

  /** Grava (ou substitui) o estudo de uma busca no dia. As contagens saem dos anúncios, não do que o agente diz. */
  async save(tenantId: string, userId: string, input: z.output<typeof productRadarProductSchema>): Promise<{ id: string }> {
    const s = summarizeProductRadar(input.listings as ProductRadarListing[]);
    return this.db.withTenant(tenantId, async (db) => {
      const r = await db.query<{ id: string }>(
        `INSERT INTO product_radar_products
           (tenant_id, day, mode, category, search, source_title, verdict, note, analyzed, pass_sales, pass_reviews, approved,
            leader_sales_per_day, thumbnail, listings, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (tenant_id, day, search) DO UPDATE SET
           mode = EXCLUDED.mode, category = EXCLUDED.category, source_title = EXCLUDED.source_title, verdict = EXCLUDED.verdict,
           note = EXCLUDED.note, analyzed = EXCLUDED.analyzed, pass_sales = EXCLUDED.pass_sales, pass_reviews = EXCLUDED.pass_reviews,
           approved = EXCLUDED.approved, leader_sales_per_day = EXCLUDED.leader_sales_per_day, thumbnail = EXCLUDED.thumbnail,
           listings = EXCLUDED.listings, created_by = EXCLUDED.created_by, created_at = now()
         RETURNING id`,
        [
          tenantId, input.day ?? todayIn(), input.mode, input.category, input.search.toLowerCase(), input.sourceTitle, input.verdict,
          input.note, s.analyzed, s.passSales, s.passReviews, s.approved, s.leaderSalesPerDay, s.thumbnail, JSON.stringify(s.listings), userId,
        ],
      );
      return { id: r.rows[0]!.id };
    });
  }

  async remove(tenantId: string, id: string): Promise<void> {
    const r = await this.db.withTenant(tenantId, (db) => db.query(`DELETE FROM product_radar_products WHERE id = $1`, [id]));
    if (!r.rowCount) throw new NotFoundError('Estudo não encontrado');
  }
}
