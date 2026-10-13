import type { Database } from '../../../shared/infrastructure/database.js';

export interface CategoryRow {
  category_id: string;
  name: string;
  parent_id: string | null;
  path: { id: string; name: string }[];
  leaf: boolean | null;
  fee_classic: string | null;
  fee_premium: string | null;
  dims: { height: number; width: number; length: number; weight: number } | null;
  fetched_at: Date;
}

/** Cache global (sem empresa) das categorias do ML: dado público, igual para todos. */
export class PgCategoryCache {
  constructor(private readonly db: Database) {}

  async get(ids: string[]): Promise<Map<string, CategoryRow>> {
    if (!ids.length) return new Map();
    const { rows } = await this.db.query<CategoryRow>('SELECT * FROM ml_categories WHERE category_id = ANY($1)', [ids]);
    return new Map(rows.map((r) => [r.category_id, r]));
  }

  async upsert(r: Omit<CategoryRow, 'fetched_at'>): Promise<void> {
    await this.db.query(
      `INSERT INTO ml_categories (category_id, name, parent_id, path, leaf, fee_classic, fee_premium, dims, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
       ON CONFLICT (category_id) DO UPDATE SET name = EXCLUDED.name, parent_id = EXCLUDED.parent_id, path = EXCLUDED.path,
         leaf = COALESCE(EXCLUDED.leaf, ml_categories.leaf), fee_classic = COALESCE(EXCLUDED.fee_classic, ml_categories.fee_classic),
         fee_premium = COALESCE(EXCLUDED.fee_premium, ml_categories.fee_premium), dims = COALESCE(EXCLUDED.dims, ml_categories.dims),
         fetched_at = now()`,
      [r.category_id, r.name, r.parent_id, JSON.stringify(r.path), r.leaf, r.fee_classic, r.fee_premium, r.dims ? JSON.stringify(r.dims) : null],
    );
  }
}
