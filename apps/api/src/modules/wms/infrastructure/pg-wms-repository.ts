import type {
  WmsBatchDto,
  WmsFindCandidateDto,
  WmsItemDto,
  WmsItemStatus,
  WmsListSummaryDto,
  WmsMarketplace,
  WmsProductDto,
} from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';

export interface ItemRow {
  id: string;
  list_id: string;
  sku: string;
  ml_code: string | null;
  ean: string | null;
  description: string;
  qty_required: number;
  qty_picked: number;
  shortage_qty: number;
  status: WmsItemStatus;
  labels_printed: boolean;
  notes: string | null;
  picture_url?: string | null;
}

export interface ListRow {
  id: string;
  batch_id: string | null;
  code: string;
  marketplace: WmsMarketplace;
  operator_id: string | null;
  status: 'open' | 'in_progress' | 'completed';
}

const TERMINAL: WmsItemStatus[] = ['complete', 'partial', 'out_of_stock'];

export const toItem = (r: ItemRow): WmsItemDto => ({
  id: r.id,
  sku: r.sku,
  mlCode: r.ml_code,
  ean: r.ean,
  description: r.description,
  qtyRequired: r.qty_required,
  qtyPicked: r.qty_picked,
  shortageQty: r.shortage_qty,
  status: r.status,
  labelsPrinted: r.labels_printed,
  labelsReady: TERMINAL.includes(r.status) && r.qty_picked > 0,
  notes: r.notes,
  pictureUrl: r.picture_url ?? null,
});

/** Foto: o primeiro anúncio com o mesmo SKU (sem custo extra de consulta ao ML). */
const PICTURE = `(SELECT l.picture_url FROM listings l WHERE upper(l.sku) = upper(i.sku) AND l.picture_url IS NOT NULL
                   ORDER BY l.status = 'active' DESC, l.sold_quantity DESC NULLS LAST LIMIT 1) AS picture_url`;

const LIST_SUMMARY = `
  SELECT l.id, l.code, l.batch_id, l.marketplace, l.status, l.operator_id, o.name AS operator_name,
         coalesce(sum(i.qty_required), 0)::int AS items_total, coalesce(sum(i.qty_picked), 0)::int AS items_picked,
         count(DISTINCT upper(i.sku))::int AS sku_count, l.completed_at, l.created_at
    FROM wms_lists l
    LEFT JOIN operators o ON o.id = l.operator_id
    LEFT JOIN wms_items i ON i.list_id = l.id`;

interface ListSummaryRow {
  id: string;
  code: string;
  batch_id: string | null;
  marketplace: WmsMarketplace;
  status: WmsListSummaryDto['status'];
  operator_id: string | null;
  operator_name: string | null;
  items_total: number;
  items_picked: number;
  sku_count: number;
  completed_at: Date | null;
  created_at: Date;
}
const toSummary = (r: ListSummaryRow): WmsListSummaryDto => ({
  id: r.id,
  code: r.code,
  batchId: r.batch_id,
  marketplace: r.marketplace,
  status: r.status,
  operatorId: r.operator_id,
  operatorName: r.operator_name,
  itemsTotal: r.items_total,
  itemsPicked: r.items_picked,
  skuCount: r.sku_count,
  completedAt: r.completed_at?.toISOString() ?? null,
  createdAt: r.created_at.toISOString(),
});

/** Lista mono-SKU primeiro (mais rápida de separar), depois as maiores. */
export const sortLists = (a: WmsListSummaryDto, b: WmsListSummaryDto) =>
  (a.skuCount === 1 ? 0 : 1) - (b.skuCount === 1 ? 0 : 1) || b.itemsTotal - a.itemsTotal;

export class PgWmsRepository {
  // ---------------- lotes e listas
  async summaries(db: Queryable, where: string, params: unknown[]): Promise<WmsListSummaryDto[]> {
    const { rows } = await db.query<ListSummaryRow>(`${LIST_SUMMARY} WHERE ${where} GROUP BY l.id, o.name ORDER BY l.code`, params);
    return rows.map(toSummary);
  }

  /** Listas "vivas" do marketplace: de lotes ativos ou avulsas. */
  async activeLists(db: Queryable, marketplace: WmsMarketplace): Promise<WmsListSummaryDto[]> {
    return this.summaries(
      db,
      `l.marketplace = $1 AND (l.batch_id IS NULL OR EXISTS (SELECT 1 FROM wms_batches b WHERE b.id = l.batch_id AND b.status = 'active'))`,
      [marketplace],
    );
  }

  async batches(db: Queryable, marketplace: WmsMarketplace, batchId?: string): Promise<WmsBatchDto[]> {
    const { rows } = await db.query<{
      id: string; name: string; marketplace: WmsMarketplace; full_date: string; inbound_ref: string | null;
      status: 'active' | 'archived'; lifecycle: WmsBatchDto['lifecycle']; created_at: Date;
    }>(
      `SELECT id, name, marketplace, to_char(full_date, 'YYYY-MM-DD') AS full_date, inbound_ref, status, lifecycle, created_at
         FROM wms_batches WHERE marketplace = $1 ${batchId ? 'AND id = $2' : ''}
        ORDER BY status = 'active' DESC, full_date DESC, seq DESC`,
      batchId ? [marketplace, batchId] : [marketplace],
    );
    if (!rows.length) return [];
    const lists = await this.summaries(db, 'l.batch_id = ANY($1)', [rows.map((b) => b.id)]);
    return rows.map((b) => {
      const own = lists.filter((l) => l.batchId === b.id).sort(sortLists);
      const total = own.reduce((s, l) => s + l.itemsTotal, 0);
      const picked = own.reduce((s, l) => s + l.itemsPicked, 0);
      return {
        id: b.id,
        name: b.name,
        marketplace: b.marketplace,
        fullDate: b.full_date,
        inboundRef: b.inbound_ref,
        status: b.status,
        lifecycle: b.lifecycle,
        totalItems: total,
        totalPicked: picked,
        pct: total ? Math.round((picked / total) * 100) : 0,
        lists: own,
        createdAt: b.created_at.toISOString(),
      };
    });
  }

  async list(db: Queryable, id: string, lock = false): Promise<ListRow | null> {
    const { rows } = await db.query<ListRow>(
      `SELECT id, batch_id, code, marketplace, operator_id, status FROM wms_lists WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  async items(db: Queryable, listId: string, withPicture = false): Promise<ItemRow[]> {
    const { rows } = await db.query<ItemRow>(
      `SELECT i.*${withPicture ? `, ${PICTURE}` : ''} FROM wms_items i WHERE i.list_id = $1
        ORDER BY i.status IN ('complete', 'partial', 'out_of_stock'), i.qty_required DESC, i.sku`,
      [listId],
    );
    return rows;
  }

  async item(db: Queryable, id: string): Promise<ItemRow | null> {
    const { rows } = await db.query<ItemRow>('SELECT * FROM wms_items WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async itemBySku(db: Queryable, listId: string, sku: string): Promise<ItemRow | null> {
    const { rows } = await db.query<ItemRow>('SELECT * FROM wms_items WHERE list_id = $1 AND upper(sku) = upper($2) ORDER BY id LIMIT 1', [
      listId,
      sku,
    ]);
    return rows[0] ?? null;
  }

  /** Sessão concluída quando todo item chegou a um estado final (ou reaberta, se não). */
  async refreshListStatus(db: Queryable, listId: string): Promise<void> {
    await db.query(
      `UPDATE wms_lists l SET
         status = CASE WHEN x.done THEN 'completed' WHEN l.status = 'completed' THEN 'in_progress' ELSE l.status END,
         completed_at = CASE WHEN x.done THEN coalesce(l.completed_at, now()) ELSE NULL END
         FROM (SELECT count(*) > 0 AND bool_and(status IN ('complete', 'partial', 'out_of_stock')) AS done
                 FROM wms_items WHERE list_id = $1) x
        WHERE l.id = $1`,
      [listId],
    );
  }

  /** 1º movimento no lote: pendente → em andamento. */
  async startBatch(db: Queryable, listId: string): Promise<void> {
    await db.query(
      `UPDATE wms_batches SET lifecycle = 'em_andamento'
        WHERE lifecycle = 'pendente' AND id = (SELECT batch_id FROM wms_lists WHERE id = $1)`,
      [listId],
    );
  }

  /** A lista vira do operador no 1º movimento. */
  async takeList(db: Queryable, listId: string, operatorId: string): Promise<void> {
    await db.query(
      `UPDATE wms_lists SET status = CASE WHEN status = 'open' THEN 'in_progress' ELSE status END,
              operator_id = coalesce(operator_id, $2)
        WHERE id = $1`,
      [listId, operatorId],
    );
  }

  async event(db: Queryable, tenantId: string, listId: string, itemId: string, operatorId: string | null, barcode: string, type: string, delta: number) {
    await db.query(
      `INSERT INTO wms_scan_events (tenant_id, list_id, item_id, operator_id, barcode, event_type, qty_delta)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [tenantId, listId, itemId, operatorId, barcode, type, delta],
    );
  }

  // ---------------- códigos de barras
  async skusForCode(db: Queryable, code: string): Promise<string[]> {
    const { rows } = await db.query<{ sku: string }>('SELECT DISTINCT upper(sku) AS sku FROM wms_barcodes WHERE barcode = $1', [code.trim()]);
    return rows.map((r) => r.sku);
  }

  async realCodeCount(db: Queryable, sku: string): Promise<number> {
    const { rows } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM wms_barcodes WHERE upper(sku) = upper($1) AND upper(barcode) <> upper($1)',
      [sku],
    );
    return rows[0]!.n;
  }

  async addCode(db: Queryable, tenantId: string, code: string, sku: string, operatorId: string | null, primary = false): Promise<boolean> {
    const { rowCount } = await db.query(
      `INSERT INTO wms_barcodes (tenant_id, barcode, sku, is_primary, added_by) VALUES ($1, $2, upper($3), $4, $5)
       ON CONFLICT DO NOTHING`,
      [tenantId, code.trim(), sku, primary, operatorId],
    );
    return (rowCount ?? 0) > 0;
  }

  async skuDescription(db: Queryable, sku: string): Promise<string | null> {
    const { rows } = await db.query<{ d: string | null }>(
      `SELECT coalesce(
         (SELECT description FROM wms_products WHERE sku = upper($1) AND description <> ''),
         (SELECT description FROM wms_items WHERE upper(sku) = upper($1) AND description <> '' LIMIT 1)) AS d`,
      [sku],
    );
    return rows[0]?.d ?? null;
  }

  async noPhysicalBarcode(db: Queryable, sku: string): Promise<boolean> {
    const { rows } = await db.query<{ f: boolean }>('SELECT no_physical_barcode AS f FROM wms_products WHERE sku = upper($1)', [sku]);
    return rows[0]?.f ?? false;
  }

  async upsertProduct(db: Queryable, tenantId: string, sku: string, description: string | null) {
    await db.query(
      `INSERT INTO wms_products (tenant_id, sku, description) VALUES ($1, upper($2), nullif($3, ''))
       ON CONFLICT (tenant_id, sku) DO UPDATE SET description = coalesce(wms_products.description, EXCLUDED.description)`,
      [tenantId, sku, description],
    );
  }

  // ---------------- busca do operador
  async candidates(db: Queryable, where: string, params: unknown[], order: string): Promise<WmsFindCandidateDto[]> {
    const { rows } = await db.query<{
      item_id: string; sku: string; ml_code: string | null; description: string; list_id: string; list_code: string;
      operator_name: string | null; qty_picked: number; qty_required: number; status: WmsItemStatus;
    }>(
      `SELECT i.id AS item_id, i.sku, i.ml_code, i.description, l.id AS list_id, l.code AS list_code, o.name AS operator_name,
              i.qty_picked, i.qty_required, i.status
         FROM wms_items i JOIN wms_lists l ON l.id = i.list_id LEFT JOIN operators o ON o.id = l.operator_id
        WHERE ${where} ORDER BY ${order} LIMIT 60`,
      params,
    );
    return rows.map((r) => ({
      itemId: r.item_id,
      sku: r.sku,
      mlCode: r.ml_code,
      description: r.description,
      listId: r.list_id,
      listCode: r.list_code,
      operatorName: r.operator_name,
      qtyPicked: r.qty_picked,
      qtyRequired: r.qty_required,
      status: r.status,
    }));
  }

  // ---------------- master data
  async products(db: Queryable, q: string, limit: number, offset: number): Promise<{ total: number; items: WmsProductDto[] }> {
    const like = `%${q.trim()}%`;
    const where = q.trim()
      ? `WHERE p.sku ILIKE $1 OR p.description ILIKE $1 OR EXISTS (SELECT 1 FROM wms_barcodes b WHERE b.sku = p.sku AND b.barcode ILIKE $1)`
      : 'WHERE $1::text IS NOT NULL';
    const { rows } = await db.query<{
      sku: string; description: string | null; no_physical_barcode: boolean; codes: string[] | null; picture_url: string | null; total: number;
    }>(
      `SELECT p.sku, p.description, p.no_physical_barcode, count(*) OVER ()::int AS total,
              (SELECT array_agg(b.barcode ORDER BY b.is_primary DESC, b.added_at) FROM wms_barcodes b
                WHERE b.sku = p.sku AND upper(b.barcode) <> p.sku) AS codes,
              (SELECT l.picture_url FROM listings l WHERE upper(l.sku) = p.sku AND l.picture_url IS NOT NULL LIMIT 1) AS picture_url
         FROM wms_products p ${where}
        ORDER BY p.sku LIMIT $2 OFFSET $3`,
      [like, limit, offset],
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((r) => ({
        sku: r.sku,
        description: r.description,
        noPhysicalBarcode: r.no_physical_barcode,
        codes: r.codes ?? [],
        pictureUrl: r.picture_url,
      })),
    };
  }
}
