import {
  computePricingStudy,
  costWithMarkup,
  type ImportQuoteInput,
  type PricingStudyDto,
  type PricingSupplierDto,
  type SavePricingStudyInput,
  type SavePricingSupplierInput,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { extractPdfText } from '../../wms/index.js';

interface Row {
  id: string; title: string; link: string | null; supplier: string | null; notes: string | null;
  fee_pct: string; tax_pct: string; packaging: string; cost: string | null; price: string | null;
  height: string | null; width: string | null; length: string | null; weight_kg: string | null; target_pct: string | null;
  margin: string | null; margin_pct: string | null; created_at: Date; updated_at: Date;
  category_id: string | null; category_name: string | null; fee_classic: string | null; fee_premium: string | null;
  listing_type: 'gold_special' | 'gold_pro' | null;
  supplier_cost: string | null; quote_ref: string | null; quote_item: string | null;
}

interface SupplierRow { id: string; name: string; cost_markup_pct: string }

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
    supplierCost: num(r.supplier_cost),
    quoteRef: r.quote_ref,
    quoteItem: r.quote_item,
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
      const { rows } = await db.query<Row>('SELECT * FROM pricing_studies ORDER BY updated_at DESC LIMIT 2000');
      return rows.map(toDto);
    });
  }

  async create(tenantId: string, userId: string, input: SavePricingStudyInput): Promise<PricingStudyDto> {
    return this.db.withTenant(tenantId, (db) => insert(db, tenantId, userId, input));
  }

  async update(tenantId: string, id: string, input: SavePricingStudyInput): Promise<PricingStudyDto> {
    const row = await this.db.withTenant(tenantId, async (db) => {
      const s = await withSupplierCost(db, tenantId, input);
      const m = computePricingStudy(s);
      const { rows } = await db.query<Row>(
        `UPDATE pricing_studies SET title = $2, link = $3, supplier = $4, notes = $5, fee_pct = $6, tax_pct = $7, packaging = $8,
                cost = $9, price = $10, height = $11, width = $12, length = $13, weight_kg = $14, target_pct = $15,
                category_id = $16, category_name = $17, fee_classic = $18, fee_premium = $19, listing_type = $20,
                supplier_cost = $21, quote_ref = $22, quote_item = $23, margin = $24, margin_pct = $25, updated_at = now()
          WHERE id = $1 RETURNING *`,
        [id, ...values(s), m.margin, m.marginPct],
      );
      return rows[0];
    });
    if (!row) throw new NotFoundError('Pesquisa não encontrada');
    return toDto(row);
  }

  async suppliers(tenantId: string): Promise<PricingSupplierDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      // fornecedor digitado em ficha antiga (antes das pastas) ganha a pasta dele
      await db.query(
        `INSERT INTO pricing_suppliers (tenant_id, name)
         SELECT DISTINCT ON (lower(btrim(supplier))) tenant_id, btrim(supplier) FROM pricing_studies
          WHERE btrim(coalesce(supplier, '')) <> '' ORDER BY lower(btrim(supplier)), updated_at DESC
         ON CONFLICT (tenant_id, lower(name)) DO NOTHING`,
      );
      const { rows } = await db.query<SupplierRow>('SELECT * FROM pricing_suppliers ORDER BY lower(name)');
      return rows.map(supplierDto);
    });
  }

  async createSupplier(tenantId: string, s: SavePricingSupplierInput): Promise<PricingSupplierDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<SupplierRow>(
        `INSERT INTO pricing_suppliers (tenant_id, name, cost_markup_pct) VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, lower(name)) DO NOTHING RETURNING *`,
        [tenantId, s.name, s.costMarkupPct],
      );
      if (!rows[0]) throw new ValidationError('Já existe um fornecedor com esse nome', { fieldErrors: { name: ['Nome já usado'] } });
      return supplierDto(rows[0]);
    });
  }

  /** Renomeia a pasta (as fichas acompanham) e, se o % mudou, refaz custo e margem das fichas que vieram de cotação. */
  async updateSupplier(tenantId: string, id: string, s: SavePricingSupplierInput): Promise<PricingSupplierDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows: old } = await db.query<SupplierRow>('SELECT * FROM pricing_suppliers WHERE id = $1', [id]);
      if (!old[0]) throw new NotFoundError('Fornecedor não encontrado');
      const clash = await db.query('SELECT 1 FROM pricing_suppliers WHERE lower(name) = lower($1) AND id <> $2', [s.name, id]);
      if (clash.rowCount) throw new ValidationError('Já existe um fornecedor com esse nome', { fieldErrors: { name: ['Nome já usado'] } });
      const { rows } = await db.query<SupplierRow>(
        'UPDATE pricing_suppliers SET name = $2, cost_markup_pct = $3, updated_at = now() WHERE id = $1 RETURNING *',
        [id, s.name, s.costMarkupPct],
      );
      await db.query('UPDATE pricing_studies SET supplier = $2 WHERE lower(supplier) = lower($1)', [old[0].name, s.name]);
      if (Number(old[0].cost_markup_pct) !== s.costMarkupPct) {
        const { rows: studies } = await db.query<Row>(
          'SELECT * FROM pricing_studies WHERE lower(supplier) = lower($1) AND supplier_cost IS NOT NULL',
          [s.name],
        );
        for (const r of studies) {
          const cost = costWithMarkup(Number(r.supplier_cost), s.costMarkupPct);
          const m = computePricingStudy({ ...toDto(r), cost });
          await db.query('UPDATE pricing_studies SET cost = $2, margin = $3, margin_pct = $4, updated_at = now() WHERE id = $1', [r.id, cost, m.margin, m.marginPct]);
        }
      }
      return supplierDto(rows[0]!);
    });
  }

  /** Exclui a pasta; as fichas ficam em "Sem fornecedor". */
  async removeSupplier(tenantId: string, id: string) {
    await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<SupplierRow>('DELETE FROM pricing_suppliers WHERE id = $1 RETURNING *', [id]);
      if (!rows[0]) throw new NotFoundError('Fornecedor não encontrado');
      await db.query('UPDATE pricing_studies SET supplier = NULL WHERE lower(supplier) = lower($1)', [rows[0].name]);
    });
  }

  /** Cotação do fornecedor → uma ficha por item, com o custo já somado do % do fornecedor. */
  async importQuote(tenantId: string, userId: string, q: ImportQuoteInput): Promise<PricingStudyDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<SupplierRow>('SELECT * FROM pricing_suppliers WHERE id = $1', [q.supplierId]);
      if (!rows[0]) throw new NotFoundError('Fornecedor não encontrado');
      const supplier = rows[0].name;
      const out: PricingStudyDto[] = [];
      for (const it of q.items) {
        out.push(
          await insert(db, tenantId, userId, {
          title: it.title, link: null, supplier, notes: null, feePct: 0, taxPct: q.taxPct, packaging: q.packaging,
          cost: null, price: null, height: null, width: null, length: null, weightKg: null, targetPct: 15,
          categoryId: null, categoryName: null, feeClassic: null, feePremium: null, listingType: null,
            supplierCost: it.supplierCost, quoteRef: q.quoteRef, quoteItem: it.title,
          }),
        );
      }
      return out;
    });
  }

  /** PDF da cotação → linhas de texto (células na ordem da esquerda para a direita), para a tela montar os itens. */
  async quotePdfRows(pdfBase64: string): Promise<string[][]> {
    let texts;
    try {
      texts = await extractPdfText(new Uint8Array(Buffer.from(pdfBase64, 'base64')));
    } catch {
      throw new ValidationError('Não foi possível ler o PDF. Envie o PDF original da cotação (não foto).');
    }
    const lines: { page: number; y: number; cells: { x: number; str: string }[] }[] = [];
    for (const t of texts) {
      const line = lines.find((l) => l.page === t.page && Math.abs(l.y - t.y) <= 2.5);
      if (line) line.cells.push({ x: t.x, str: t.str.trim() });
      else lines.push({ page: t.page, y: t.y, cells: [{ x: t.x, str: t.str.trim() }] });
    }
    return lines
      .sort((a, b) => a.page - b.page || b.y - a.y)
      .map((l) => l.cells.sort((a, b) => a.x - b.x).map((c) => c.str))
      .slice(0, 3000);
  }

  async remove(tenantId: string, id: string) {
    const n = await this.db.withTenant(tenantId, async (db) => (await db.query('DELETE FROM pricing_studies WHERE id = $1', [id])).rowCount);
    if (!n) throw new NotFoundError('Pesquisa não encontrada');
  }
}

async function insert(db: Queryable, tenantId: string, userId: string, input: SavePricingStudyInput): Promise<PricingStudyDto> {
  const s = await withSupplierCost(db, tenantId, input);
  const m = computePricingStudy(s);
  const { rows } = await db.query<Row>(
    `INSERT INTO pricing_studies (tenant_id, title, link, supplier, notes, fee_pct, tax_pct, packaging, cost, price,
                                  height, width, length, weight_kg, target_pct, category_id, category_name, fee_classic,
                                  fee_premium, listing_type, supplier_cost, quote_ref, quote_item, margin, margin_pct, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26)
     RETURNING *`,
    [tenantId, ...values(s), m.margin, m.marginPct, userId],
  );
  return toDto(rows[0]!);
}

const supplierDto = (r: SupplierRow): PricingSupplierDto => ({ id: r.id, name: r.name, costMarkupPct: Number(r.cost_markup_pct) });

function values(s: SavePricingStudyInput) {
  return [s.title, s.link, s.supplier, s.notes, s.feePct, s.taxPct, s.packaging, s.cost, s.price, s.height, s.width, s.length, s.weightKg, s.targetPct,
    s.categoryId, s.categoryName, s.feeClassic, s.feePremium, s.listingType, s.supplierCost, s.quoteRef, s.quoteItem];
}

/** Garante a pasta do fornecedor e, se a ficha veio de cotação, recalcula o custo com o % dele. */
async function withSupplierCost(db: Queryable, tenantId: string, s: SavePricingStudyInput): Promise<SavePricingStudyInput> {
  if (!s.supplier) return s;
  const { rows } = await db.query<SupplierRow>(
    `WITH ins AS (
       INSERT INTO pricing_suppliers (tenant_id, name) VALUES ($1, $2)
       ON CONFLICT (tenant_id, lower(name)) DO NOTHING RETURNING *
     )
     SELECT * FROM ins UNION ALL SELECT * FROM pricing_suppliers WHERE lower(name) = lower($2) LIMIT 1`,
    [tenantId, s.supplier],
  );
  const sup = rows[0]!;
  return { ...s, supplier: sup.name, cost: s.supplierCost === null ? s.cost : costWithMarkup(s.supplierCost, Number(sup.cost_markup_pct)) };
}
