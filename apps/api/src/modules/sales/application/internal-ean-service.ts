import { internalEan, type GenerateEansInput, type GenerateEansResult, type InternalEanDto, type InternalEanListDto, type UpdateEanInput } from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';

interface Row { code: string; sku: string | null; description: string | null; gtin: string | null; created_at: Date; in_master: boolean }

const SELECT = `SELECT e.code, e.sku, e.description, e.gtin, e.created_at,
                       EXISTS (SELECT 1 FROM wms_barcodes b WHERE b.barcode = e.code) AS in_master
                  FROM internal_eans e`;

const toDto = (r: Row): InternalEanDto => ({
  code: r.code,
  sku: r.sku,
  description: r.description,
  gtin: r.gtin,
  inMasterData: r.in_master,
  createdAt: r.created_at.toISOString(),
});

/**
 * EAN interno (circulação restrita GS1, prefixo 20). Pode nascer "livre" e ser associado a um SKU depois. Se o SKU
 * existe no Master Data do Full, o código (e o GTIN oficial, quando houver) entra como código de bipagem.
 */
export class InternalEanService {
  constructor(private readonly db: Database) {}

  async list(tenantId: string, p: { q?: string; offset: number; limit: number }): Promise<InternalEanListDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const term = p.q ? `%${p.q}%` : null;
      const where = `WHERE ($1::text IS NULL OR e.code ILIKE $1 OR e.sku ILIKE $1 OR e.description ILIKE $1 OR e.gtin ILIKE $1)`;
      const [rows, totals] = await Promise.all([
        db.query<Row>(`${SELECT} ${where} ORDER BY e.created_at DESC, e.code DESC LIMIT $2 OFFSET $3`, [term, p.limit, p.offset]),
        db.query<{ total: string; free: string }>(
          `SELECT count(*) AS total, (SELECT count(*) FROM internal_eans WHERE sku IS NULL) AS free FROM internal_eans e ${where}`,
          [term],
        ),
      ]);
      return { items: rows.rows.map(toDto), total: Number(totals.rows[0]!.total), free: Number(totals.rows[0]!.free) };
    });
  }

  async byCodes(tenantId: string, codes: string[]): Promise<InternalEanDto[]> {
    return this.db.withTenant(tenantId, async (db) => (await db.query<Row>(`${SELECT} WHERE e.code = ANY($1) ORDER BY e.code`, [codes])).rows.map(toDto));
  }

  async generate(tenantId: string, userId: string, input: GenerateEansInput): Promise<GenerateEansResult> {
    // SKU repetido no lote vale uma vez só (a primeira descrição); itens sem SKU viram códigos livres
    const seen = new Set<string>();
    const items = input.items.filter((i) => i.sku === null || (!seen.has(i.sku) && seen.add(i.sku)));
    return this.db.withTenant(tenantId, async (db) => {
      const skus = items.flatMap((i) => (i.sku ? [i.sku] : []));
      const existingRows = skus.length ? (await db.query<Row>(`${SELECT} WHERE e.sku = ANY($1)`, [skus])).rows : [];
      const have = new Set(existingRows.map((r) => r.sku));
      const fresh = items.filter((i) => !i.sku || !have.has(i.sku));
      const codes: string[] = [];
      if (fresh.length) {
        // reserva a faixa de uma vez; a linha do contador fica travada até o fim da transação
        const { rows } = await db.query<{ last_seq: string }>(
          `INSERT INTO internal_ean_counters (tenant_id, last_seq) VALUES ($1, $2)
           ON CONFLICT (tenant_id) DO UPDATE SET last_seq = internal_ean_counters.last_seq + $2
           RETURNING last_seq`,
          [tenantId, fresh.length],
        );
        const first = Number(rows[0]!.last_seq) - fresh.length + 1;
        for (const [i, it] of fresh.entries()) {
          const code = internalEan(first + i);
          await db.query(`INSERT INTO internal_eans (tenant_id, code, sku, description, created_by) VALUES ($1, $2, $3, $4, $5)`, [
            tenantId, code, it.sku, it.description, userId,
          ]);
          if (it.sku) await linkToMasterData(db, tenantId, it.sku, code);
          codes.push(code);
        }
      }
      const created = codes.length ? (await db.query<Row>(`${SELECT} WHERE e.code = ANY($1) ORDER BY e.code`, [codes])).rows.map(toDto) : [];
      return { created, existing: existingRows.map(toDto) };
    });
  }

  async update(tenantId: string, code: string, patch: UpdateEanInput): Promise<InternalEanDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const cur = (await db.query<{ sku: string | null; description: string | null; gtin: string | null }>(
        'SELECT sku, description, gtin FROM internal_eans WHERE code = $1 FOR UPDATE',
        [code],
      )).rows[0];
      if (!cur) throw new NotFoundError('Código não encontrado');
      const next = {
        sku: patch.sku === undefined ? cur.sku : patch.sku,
        description: patch.description === undefined ? cur.description : patch.description,
        gtin: patch.gtin === undefined ? cur.gtin : patch.gtin || null,
      };
      if (next.sku && next.sku !== cur.sku) {
        const owner = (await db.query<{ code: string }>('SELECT code FROM internal_eans WHERE sku = $1', [next.sku])).rows[0];
        if (owner) throw new ValidationError(`O SKU ${next.sku} já tem o código ${owner.code}.`);
      }
      await db.query('UPDATE internal_eans SET sku = $2, description = $3, gtin = $4 WHERE code = $1', [code, next.sku, next.description, next.gtin]);
      // Master Data: tira os códigos do SKU antigo e põe no novo (se ele estiver cadastrado no Full)
      if (cur.sku) await db.query('DELETE FROM wms_barcodes WHERE sku = $1 AND barcode = ANY($2)', [cur.sku, [code, cur.gtin].filter(Boolean)]);
      if (next.sku) for (const c of [code, next.gtin]) if (c) await linkToMasterData(db, tenantId, next.sku, c);
      return toDto((await db.query<Row>(`${SELECT} WHERE e.code = $1`, [code])).rows[0]!);
    });
  }

  async remove(tenantId: string, code: string) {
    await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ sku: string | null; gtin: string | null }>('DELETE FROM internal_eans WHERE code = $1 RETURNING sku, gtin', [code]);
      if (!rows[0]) throw new NotFoundError('Código não encontrado');
      if (rows[0].sku) await db.query('DELETE FROM wms_barcodes WHERE barcode = $1 AND sku = $2', [code, rows[0].sku]);
    });
  }
}

/** Só para SKU que já está no Master Data do Full: o código passa a valer na bipagem. */
async function linkToMasterData(db: Queryable, tenantId: string, sku: string, code: string) {
  await db.query(
    `INSERT INTO wms_barcodes (tenant_id, barcode, sku)
     SELECT $1, $2, p.sku FROM wms_products p WHERE p.sku = upper($3)
     ON CONFLICT DO NOTHING`,
    [tenantId, code, sku],
  );
}
