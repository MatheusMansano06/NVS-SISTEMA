import { computePricingStudy, type PricingStudyDto, type SavePricingStudyInput } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { NotFoundError } from '../../../shared/kernel/errors.js';

interface Row {
  id: string; title: string; link: string | null; supplier: string | null; notes: string | null;
  fee_pct: string; tax_pct: string; packaging: string; cost: string | null; price: string | null;
  height: string | null; width: string | null; length: string | null; weight_kg: string | null; target_pct: string | null;
  margin: string | null; margin_pct: string | null; created_at: Date; updated_at: Date;
  category_id: string | null; category_name: string | null; fee_classic: string | null; fee_premium: string | null;
  listing_type: 'gold_special' | 'gold_pro' | null;
}

const num = (v: string | null) => (v === null ? null : Number(v));

function toDto(r: Row): PricingStudyDto {
  return {
    id: r.id,
    title: r.title,
    link: r.link,
    supplier: r.supplier,
    notes: r.notes,
    feePct: Number(r.fee_pct),
    taxPct: Number(r.tax_pct),
    packaging: Number(r.packaging),
    cost: num(r.cost),
    price: num(r.price),
    height: num(r.height),
    width: num(r.width),
    length: num(r.length),
    weightKg: num(r.weight_kg),
    targetPct: num(r.target_pct),
    categoryId: r.category_id,
    categoryName: r.category_name,
    feeClassic: num(r.fee_classic),
    feePremium: num(r.fee_premium),
    listingType: r.listing_type,
    margin: num(r.margin),
    marginPct: num(r.margin_pct),
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  };
}

/** Pesquisas de viabilidade: a margem é recalculada aqui com a mesma regra da tela, não confiada ao navegador. */
export class PricingStudyService {
  constructor(private readonly db: Database) {}

  async list(tenantId: string): Promise<PricingStudyDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<Row>('SELECT * FROM pricing_studies ORDER BY updated_at DESC LIMIT 500');
      return rows.map(toDto);
    });
  }

  async create(tenantId: string, userId: string, s: SavePricingStudyInput): Promise<PricingStudyDto> {
    const m = computePricingStudy(s);
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<Row>(
        `INSERT INTO pricing_studies (tenant_id, title, link, supplier, notes, fee_pct, tax_pct, packaging, cost, price,
                                      height, width, length, weight_kg, target_pct, category_id, category_name, fee_classic,
                                      fee_premium, listing_type, margin, margin_pct, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23)
         RETURNING *`,
        [tenantId, ...values(s), m.margin, m.marginPct, userId],
      );
      return toDto(rows[0]!);
    });
  }

  async update(tenantId: string, id: string, s: SavePricingStudyInput): Promise<PricingStudyDto> {
    const m = computePricingStudy(s);
    const row = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<Row>(
        `UPDATE pricing_studies SET title = $2, link = $3, supplier = $4, notes = $5, fee_pct = $6, tax_pct = $7, packaging = $8,
                cost = $9, price = $10, height = $11, width = $12, length = $13, weight_kg = $14, target_pct = $15,
                category_id = $16, category_name = $17, fee_classic = $18, fee_premium = $19, listing_type = $20,
                margin = $21, margin_pct = $22, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, ...values(s), m.margin, m.marginPct],
      );
      return rows[0];
    });
    if (!row) throw new NotFoundError('Pesquisa não encontrada');
    return toDto(row);
  }

  async remove(tenantId: string, id: string) {
    const n = await this.db.withTenant(tenantId, async (db) => (await db.query('DELETE FROM pricing_studies WHERE id = $1', [id])).rowCount);
    if (!n) throw new NotFoundError('Pesquisa não encontrada');
  }
}

function values(s: SavePricingStudyInput) {
  return [s.title, s.link, s.supplier, s.notes, s.feePct, s.taxPct, s.packaging, s.cost, s.price, s.height, s.width, s.length, s.weightKg, s.targetPct,
    s.categoryId, s.categoryName, s.feeClassic, s.feePremium, s.listingType];
}
