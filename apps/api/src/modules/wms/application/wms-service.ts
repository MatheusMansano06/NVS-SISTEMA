import {
  WMS_LIST_MAX_UNITS,
  WMS_MAX_ACTIVE_BATCHES,
  type WmsAgentStatusDto,
  type WmsBatchDto,
  type WmsFindDto,
  type WmsInboundResultDto,
  type WmsItemDto,
  type WmsListDetailDto,
  type WmsListSummaryDto,
  type WmsMarketplace,
  type WmsOverviewDto,
  type WmsPrintJobDto,
  type WmsProductDto,
  type WmsProductPageDto,
  type WmsRankingDto,
  type WmsScanResultDto,
  type WmsShortageDto,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { parseInboundText, splitIntoLists, type InboundItem } from '../domain/ml-inbound-pdf.js';
import { buildLabelsZpl } from '../domain/zpl.js';
import { extractPdfText } from '../infrastructure/pdf-text.js';
import { sortLists, toItem, toJob, type ItemRow, type ListRow, type PgWmsRepository, type PrintRow } from '../infrastructure/pg-wms-repository.js';
import { hashAgentKey, newAgentKey, type PrintHub } from '../infrastructure/print-hub.js';

/** Quem está agindo (pessoa da equipe que entrou com nome + PIN). */
export interface Actor {
  tenantId: string;
  operatorId: string;
  mode: 'analise' | 'operacao';
  master: boolean;
}

class Blocked extends AppError {
  constructor(message: string) {
    super(message, 'WMS_BLOCKED', 409);
  }
}

const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}-${iso.slice(5, 7)}-${iso.slice(0, 4)}`;
const TERMINAL = new Set(['complete', 'partial', 'out_of_stock']);

/**
 * Supervisão Full (portado do NVS-WMS): envio do Full (PDF do ML) → lote → listas de até 1.000 unidades →
 * o operador bipa (unidade ou caixa), marca falta/sem estoque e as etiquetas saem na Zebra ao concluir o item.
 * Regra de ouro do NVS-WMS: quem bipa vira dono da lista; item de outra pessoa só passa por transferência.
 */
export class WmsService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgWmsRepository,
    private readonly hub: PrintHub,
  ) {}

  // ================= Processamento (Análise)
  async inbound(
    a: Actor,
    input: { marketplace: WmsMarketplace; fullDate: string; pdfBase64: string; archiveOldestId?: string },
  ): Promise<WmsInboundResultDto> {
    if (a.mode !== 'analise') throw new ForbiddenError('O Processamento é feito pela Análise.');
    if (input.marketplace !== 'ml') throw new ValidationError('Por enquanto só o PDF do Mercado Livre é lido aqui.');
    const pdf = Buffer.from(input.pdfBase64, 'base64');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ValidationError('O arquivo não é um PDF.');
    let parsed;
    try {
      parsed = parseInboundText(await extractPdfText(new Uint8Array(pdf)));
    } catch {
      throw new ValidationError('Não foi possível ler o PDF. Use o PDF de preparação do envio Full baixado do Mercado Livre.');
    }
    if (!parsed.items.length) {
      throw new ValidationError('Nenhum produto encontrado no PDF. É o PDF "Lista de produtos e instruções de preparação" do envio Full?');
    }
    const units = parsed.items.reduce((s, i) => s + i.qty, 0);

    return this.db.withTenant(a.tenantId, async (db) => {
      // vários lotes ao mesmo tempo, com limite: o mais antigo é arquivado (pedindo confirmação se tiver pendência)
      const active = (
        await db.query<{ id: string; name: string }>(
          `SELECT id, name FROM wms_batches WHERE status = 'active' AND marketplace = $1 ORDER BY full_date, seq FOR UPDATE`,
          [input.marketplace],
        )
      ).rows;
      if (active.length >= WMS_MAX_ACTIVE_BATCHES) {
        const oldest = active[0]!;
        const pending = (
          await db.query<{ n: number }>(
            `SELECT count(*)::int AS n FROM wms_items i JOIN wms_lists l ON l.id = i.list_id
              WHERE l.batch_id = $1 AND i.status IN ('pending', 'in_progress')`,
            [oldest.id],
          )
        ).rows[0]!.n;
        if (pending > 0 && input.archiveOldestId !== oldest.id) {
          return { status: 'needs_archive', oldest: { id: oldest.id, name: oldest.name, pending } };
        }
        await db.query(`UPDATE wms_batches SET status = 'archived' WHERE id = $1`, [oldest.id]);
      }

      const seq =
        (await db.query<{ n: number }>('SELECT count(*)::int AS n FROM wms_batches WHERE marketplace = $1 AND full_date = $2', [
          input.marketplace,
          input.fullDate,
        ])).rows[0]!.n + 1;
      const dateBr = ddmmyyyy(input.fullDate).replace(/-/g, '/');
      const name = seq === 1 ? dateBr : `${dateBr} · nº${seq}`;
      const batch = (
        await db.query<{ id: string }>(
          `INSERT INTO wms_batches (tenant_id, marketplace, full_date, seq, name, inbound_ref, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [a.tenantId, input.marketplace, input.fullDate, seq, name, parsed.ref, a.operatorId],
        )
      ).rows[0]!;

      const prefix = `${input.marketplace === 'shopee' ? 'SH' : 'ML'}-${ddmmyyyy(input.fullDate)}${seq > 1 ? `-${String.fromCharCode(64 + seq)}` : ''}`;
      const groups = splitIntoLists(parsed.items, WMS_LIST_MAX_UNITS);
      for (const [i, group] of groups.entries()) {
        const code = groups.length > 1 ? `${prefix}-L${String(i + 1).padStart(2, '0')}` : prefix;
        const list = (
          await db.query<{ id: string }>(
            `INSERT INTO wms_lists (tenant_id, batch_id, code, marketplace) VALUES ($1, $2, $3, $4) RETURNING id`,
            [a.tenantId, batch.id, code, input.marketplace],
          )
        ).rows[0]!;
        for (const it of group) await this.insertItem(db, a.tenantId, list.id, it);
      }
      // Master Data: produto + Código ML e EAN como códigos bipáveis
      for (const it of parsed.items) {
        await this.repo.upsertProduct(db, a.tenantId, it.sku, it.description);
        if (it.mlCode) await this.repo.addCode(db, a.tenantId, it.mlCode, it.sku, a.operatorId);
        if (it.ean) await this.repo.addCode(db, a.tenantId, it.ean, it.sku, a.operatorId, true);
      }
      const [dto] = await this.repo.batches(db, input.marketplace, batch.id);
      return { status: 'ok', batch: dto!, units, declaredUnits: parsed.declaredUnits };
    });
  }

  private async insertItem(db: Queryable, tenantId: string, listId: string, it: InboundItem) {
    await db.query(
      `INSERT INTO wms_items (tenant_id, list_id, sku, ml_code, ean, description, qty_required) VALUES ($1, $2, upper($3), $4, $5, $6, $7)`,
      [tenantId, listId, it.sku, it.mlCode, it.ean, it.description, it.qty],
    );
  }

  // ================= Visão geral / lotes
  async overview(tenantId: string, marketplace: WmsMarketplace): Promise<WmsOverviewDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const lists = await this.repo.activeLists(db, marketplace);
      const ids = lists.map((l) => l.id);
      const short = ids.length
        ? (
            await db.query<{ units: number; skus: number }>(
              `SELECT coalesce(sum(shortage_qty), 0)::int AS units, count(DISTINCT upper(sku)) FILTER (WHERE shortage_qty > 0)::int AS skus
                 FROM wms_items WHERE list_id = ANY($1)`,
              [ids],
            )
          ).rows[0]!
        : { units: 0, skus: 0 };
      const batches = (
        await db.query<{ id: string; name: string; status: 'active' | 'archived' }>(
          `SELECT id, name, status FROM wms_batches WHERE marketplace = $1 ORDER BY status = 'active' DESC, full_date DESC, seq DESC LIMIT 20`,
          [marketplace],
        )
      ).rows;
      return {
        marketplace,
        lists: {
          total: lists.length,
          open: lists.filter((l) => l.status === 'open').length,
          inProgress: lists.filter((l) => l.status === 'in_progress').length,
          completed: lists.filter((l) => l.status === 'completed').length,
        },
        units: { total: lists.reduce((s, l) => s + l.itemsTotal, 0), picked: lists.reduce((s, l) => s + l.itemsPicked, 0) },
        shortage: short,
        batches,
      };
    });
  }

  /** Ranking por unidades separadas (bipadas, caixas, falta parcial, desfeitas descontam). */
  async ranking(tenantId: string, marketplace: WmsMarketplace, batchId?: string): Promise<WmsRankingDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ name: string; total: number }>(
        `SELECT o.name, sum(e.qty_delta)::int AS total
           FROM wms_scan_events e JOIN operators o ON o.id = e.operator_id JOIN wms_lists l ON l.id = e.list_id
          WHERE l.marketplace = $1 AND ($2::uuid IS NULL OR l.batch_id = $2)
            AND e.event_type IN ('scan', 'scan_box', 'undo', 'shortage', 'manual')
          GROUP BY o.name HAVING sum(e.qty_delta) > 0 ORDER BY 2 DESC LIMIT 20`,
        [marketplace, batchId ?? null],
      );
      return { operators: rows };
    });
  }

  async batches(tenantId: string, marketplace: WmsMarketplace): Promise<{ batches: WmsBatchDto[]; loose: WmsListSummaryDto[] }> {
    return this.db.withTenant(tenantId, async (db) => ({
      batches: await this.repo.batches(db, marketplace),
      loose: (await this.repo.summaries(db, 'l.marketplace = $1 AND l.batch_id IS NULL', [marketplace])).sort(sortLists),
    }));
  }

  async batch(tenantId: string, id: string): Promise<WmsBatchDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const mp = (await db.query<{ marketplace: WmsMarketplace }>('SELECT marketplace FROM wms_batches WHERE id = $1', [id])).rows[0];
      if (!mp) throw new NotFoundError('Lote não encontrado');
      return (await this.repo.batches(db, mp.marketplace, id))[0]!;
    });
  }

  async setLifecycle(a: Actor, id: string, lifecycle: 'em_andamento' | 'finalizado') {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query(`UPDATE wms_batches SET lifecycle = $2 WHERE id = $1 AND status = 'active'`, [id, lifecycle]);
      if (!r.rowCount) throw new NotFoundError('Lote não encontrado (ou arquivado)');
    });
  }

  async archive(a: Actor, id: string, archived: boolean) {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('UPDATE wms_batches SET status = $2 WHERE id = $1', [id, archived ? 'archived' : 'active']);
      if (!r.rowCount) throw new NotFoundError('Lote não encontrado');
    });
  }

  async deleteBatch(a: Actor, id: string) {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('DELETE FROM wms_batches WHERE id = $1', [id]);
      if (!r.rowCount) throw new NotFoundError('Lote não encontrado');
    });
  }

  private analysis(a: Actor) {
    if (a.mode !== 'analise' && !a.master) throw new ForbiddenError('Só a Análise (ou um MASTER) pode fazer isso.');
  }

  // ================= Listas (operador)
  async lists(tenantId: string, marketplace: WmsMarketplace): Promise<WmsListSummaryDto[]> {
    return this.db.withTenant(tenantId, async (db) => (await this.repo.activeLists(db, marketplace)).sort(sortLists));
  }

  async detail(tenantId: string, listId: string): Promise<WmsListDetailDto> {
    return this.db.withTenant(tenantId, (db) => this.detailIn(db, listId));
  }

  private async detailIn(db: Queryable, listId: string): Promise<WmsListDetailDto> {
    const [list] = await this.repo.summaries(db, 'l.id = $1', [listId]);
    if (!list) throw new NotFoundError('Lista não encontrada');
    const items = (await this.repo.items(db, listId, true)).map(toItem);
    return { list, items, current: items.find((i) => i.status === 'pending' || i.status === 'in_progress') ?? null };
  }

  /** Pegar uma lista livre (só reserva; vira "em andamento" no 1º bip). */
  async claim(a: Actor, listId: string) {
    await this.db.withTenant(a.tenantId, async (db) => {
      const l = await this.repo.list(db, listId, true);
      if (!l) throw new NotFoundError('Lista não encontrada');
      if (l.operator_id === a.operatorId) return;
      if (l.operator_id || l.status !== 'open') throw new Blocked('Esta lista já está com outra pessoa.');
      await db.query('UPDATE wms_lists SET operator_id = $2 WHERE id = $1', [listId, a.operatorId]);
    });
  }

  async scan(a: Actor, listId: string, input: { barcode: string; focusSku?: string; mode: 'unit' | 'box'; qty?: number }): Promise<WmsScanResultDto> {
    const code = input.barcode.trim();
    const result = await this.db.withTenant(a.tenantId, async (db): Promise<WmsScanResultDto> => {
      const list = await this.repo.list(db, listId, true);
      if (!list) throw new NotFoundError('Lista não encontrada');
      const skus = await this.repo.skusForCode(db, code);
      if (!skus.length) {
        // código novo: pode ser vinculado ao item em foco se ele ainda não tem nenhum código real
        const canLink = Boolean(input.focusSku) && (await this.repo.realCodeCount(db, input.focusSku!)) === 0;
        return { status: 'unknown_barcode', barcode: code, canLink };
      }
      // o texto do próprio SKU não vale como bipagem
      if (skus.length === 1 && code.toUpperCase() === skus[0]) return { status: 'unknown_barcode', barcode: code, canLink: false };

      const focus = input.focusSku?.toUpperCase();
      if (focus && !skus.includes(focus)) {
        return { status: 'wrong_sku', barcode: code, ownerSku: skus[0]!, ownerDescription: await this.repo.skuDescription(db, skus[0]!), expectedSku: focus };
      }
      const here = (
        await db.query<ItemRow>('SELECT * FROM wms_items WHERE list_id = $1 AND upper(sku) = ANY($2) ORDER BY qty_required DESC', [listId, skus])
      ).rows;
      if (!here.length) return this.elsewhere(db, list, skus, code);
      let item: ItemRow | undefined;
      if (focus) item = here.find((i) => i.sku.toUpperCase() === focus);
      else if (here.length > 1) {
        const open = here.filter((i) => !TERMINAL.has(i.status));
        if (open.length !== 1) return { status: 'ambiguous', barcode: code, candidates: here.map(toItem) };
        item = open[0];
      } else item = here[0];
      if (!item) throw new NotFoundError('Item não encontrado nesta lista');

      // regra de ouro: lista de outra pessoa só por transferência
      if (list.operator_id && list.operator_id !== a.operatorId) {
        return { status: 'transfer_available', barcode: code, itemId: item.id, sku: item.sku, ownerName: await this.ownerName(db, list.operator_id) };
      }
      if (item.qty_picked >= item.qty_required || TERMINAL.has(item.status)) return { status: 'excess', item: toItem(item) };

      const want = input.mode === 'box' ? Math.min(input.qty ?? item.qty_required - item.qty_picked, item.qty_required - item.qty_picked) : 1;
      if (want <= 0) return this.outOfStockIn(db, a, list, item, 'Caixa sem unidades');
      const upd = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = qty_picked + $2, status = 'in_progress'
            WHERE id = $1 AND qty_picked + $2 <= qty_required RETURNING *`,
          [item.id, want],
        )
      ).rows[0];
      if (!upd) return { status: 'excess', item: toItem((await this.repo.item(db, item.id))!) };
      await this.repo.takeList(db, listId, a.operatorId);
      await this.repo.event(db, a.tenantId, listId, upd.id, a.operatorId, code, input.mode === 'box' ? 'scan_box' : 'scan', want);
      await this.repo.startBatch(db, listId);

      const boxShort = input.mode === 'box' && input.qty !== undefined && upd.qty_picked < upd.qty_required;
      if (upd.qty_picked >= upd.qty_required || boxShort) {
        const done = (
          await db.query<ItemRow>(
            `UPDATE wms_items SET status = $2, shortage_qty = qty_required - qty_picked, completed_at = now() WHERE id = $1 RETURNING *`,
            [upd.id, upd.qty_picked >= upd.qty_required ? 'complete' : 'partial'],
          )
        ).rows[0]!;
        await this.repo.refreshListStatus(db, listId);
        return { status: 'complete', item: toItem(done) };
      }
      return { status: 'ok', item: toItem(upd) };
    });
    // etiquetas saem sozinhas ao concluir o item (fora da transação da bipagem)
    if (result.status === 'complete' && result.item.labelsReady && !result.item.labelsPrinted) {
      result.print = await this.print(a, listId, result.item.sku).catch(() => null);
    }
    return result;
  }

  /** Código conhecido, mas o SKU não está nesta lista: sugere transferir de outra lista (mesmo marketplace). */
  private async elsewhere(db: Queryable, list: ListRow, skus: string[], code: string): Promise<WmsScanResultDto> {
    const other = (
      await db.query<{ id: string; sku: string; operator_id: string | null }>(
        `SELECT i.id, i.sku, l.operator_id FROM wms_items i JOIN wms_lists l ON l.id = i.list_id
          WHERE upper(i.sku) = ANY($1) AND l.status <> 'completed' AND l.marketplace = $2 AND i.qty_picked = 0 AND i.status = 'pending'
          ORDER BY i.qty_required DESC LIMIT 1`,
        [skus, list.marketplace],
      )
    ).rows[0];
    if (other) {
      return { status: 'transfer_available', barcode: code, itemId: other.id, sku: other.sku, ownerName: other.operator_id ? await this.ownerName(db, other.operator_id) : 'Disponível' };
    }
    return { status: 'wrong_list', barcode: code, sku: skus[0]!, description: await this.repo.skuDescription(db, skus[0]!) };
  }

  private async ownerName(db: Queryable, id: string) {
    return (await db.query<{ name: string }>('SELECT name FROM operators WHERE id = $1', [id])).rows[0]?.name ?? 'Outra pessoa';
  }

  private async ownItem(db: Queryable, a: Actor, listId: string, sku: string) {
    const list = await this.repo.list(db, listId, true);
    if (!list) throw new NotFoundError('Lista não encontrada');
    if (list.operator_id && list.operator_id !== a.operatorId && a.mode !== 'analise') {
      throw new Blocked('Esta lista está com outra pessoa.');
    }
    const item = await this.repo.itemBySku(db, listId, sku);
    if (!item) throw new NotFoundError('Item não encontrado nesta lista');
    return { list, item };
  }

  async undo(a: Actor, listId: string, sku: string): Promise<WmsItemDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const { item } = await this.ownItem(db, a, listId, sku);
      if (item.qty_picked <= 0) return toItem(item);
      const r = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = qty_picked - 1, shortage_qty = 0, completed_at = NULL,
                  status = CASE WHEN qty_picked - 1 = 0 THEN 'pending' ELSE 'in_progress' END
            WHERE id = $1 RETURNING *`,
          [item.id],
        )
      ).rows[0]!;
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'UNDO', 'undo', -1);
      await this.repo.refreshListStatus(db, listId);
      return toItem(r);
    });
  }

  /** Falta: achou só `qtyFound`; o resto vai para o relatório de faltas. */
  async shortage(a: Actor, listId: string, input: { sku: string; qtyFound: number; notes?: string }): Promise<WmsScanResultDto> {
    const result = await this.db.withTenant(a.tenantId, async (db): Promise<WmsScanResultDto> => {
      const { item } = await this.ownItem(db, a, listId, input.sku);
      const found = Math.min(input.qtyFound, item.qty_required);
      const r = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = $2, shortage_qty = qty_required - $2, completed_at = now(), notes = coalesce($3, notes),
                  status = CASE WHEN $2 >= qty_required THEN 'complete' WHEN $2 = 0 THEN 'out_of_stock' ELSE 'partial' END
            WHERE id = $1 RETURNING *`,
          [item.id, found, input.notes || null],
        )
      ).rows[0]!;
      await this.repo.takeList(db, listId, a.operatorId);
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'SHORTAGE', 'shortage', found - item.qty_picked);
      await this.repo.startBatch(db, listId);
      await this.repo.refreshListStatus(db, listId);
      return { status: 'complete', item: toItem(r) };
    });
    if (result.status === 'complete' && result.item.labelsReady) result.print = await this.print(a, listId, result.item.sku).catch(() => null);
    return result;
  }

  async outOfStock(a: Actor, listId: string, input: { sku: string; notes?: string }): Promise<WmsScanResultDto> {
    const result = await this.db.withTenant(a.tenantId, async (db) => {
      const { list, item } = await this.ownItem(db, a, listId, input.sku);
      return this.outOfStockIn(db, a, list, item, input.notes);
    });
    if (result.status === 'complete' && result.item.labelsReady) result.print = await this.print(a, listId, result.item.sku).catch(() => null);
    return result;
  }

  private async outOfStockIn(db: Queryable, a: Actor, list: ListRow, item: ItemRow, notes?: string): Promise<WmsScanResultDto> {
    const r = (
      await db.query<ItemRow>(
        `UPDATE wms_items SET shortage_qty = qty_required - qty_picked, completed_at = now(), notes = coalesce($2, notes),
                status = CASE WHEN qty_picked > 0 THEN 'partial' ELSE 'out_of_stock' END
          WHERE id = $1 RETURNING *`,
        [item.id, notes || null],
      )
    ).rows[0]!;
    await this.repo.takeList(db, list.id, a.operatorId);
    await this.repo.event(db, a.tenantId, list.id, item.id, a.operatorId, 'OOS', 'out_of_stock', 0);
    await this.repo.startBatch(db, list.id);
    await this.repo.refreshListStatus(db, list.id);
    return { status: 'complete', item: toItem(r) };
  }

  /** Volta o item para o começo (zera bipagens e falta). */
  async resetItem(a: Actor, listId: string, sku: string): Promise<WmsItemDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const { item } = await this.ownItem(db, a, listId, sku);
      const r = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = 0, shortage_qty = 0, status = 'pending', completed_at = NULL, labels_printed = false
            WHERE id = $1 RETURNING *`,
          [item.id],
        )
      ).rows[0]!;
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'RESET', 'reset', -item.qty_picked);
      await this.repo.refreshListStatus(db, listId);
      return toItem(r);
    });
  }

  /** Separação sem bipe, só para produto marcado no Master Data como "sem código físico". */
  async manualPick(a: Actor, listId: string, sku: string, mode: 'unit' | 'box'): Promise<WmsScanResultDto> {
    const result = await this.db.withTenant(a.tenantId, async (db): Promise<WmsScanResultDto> => {
      if (!(await this.repo.noPhysicalBarcode(db, sku))) throw new Blocked('Este produto precisa ser bipado. Só itens marcados "sem código" no Master Data saem sem bipe.');
      const { list, item } = await this.ownItem(db, a, listId, sku);
      if (list.operator_id && list.operator_id !== a.operatorId) throw new Blocked('Esta lista está com outra pessoa.');
      if (item.qty_picked >= item.qty_required) return { status: 'excess', item: toItem(item) };
      const delta = mode === 'unit' ? 1 : item.qty_required - item.qty_picked;
      const r = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = qty_picked + $2,
                  status = CASE WHEN qty_picked + $2 >= qty_required THEN 'complete' ELSE 'in_progress' END,
                  completed_at = CASE WHEN qty_picked + $2 >= qty_required THEN now() ELSE NULL END
            WHERE id = $1 RETURNING *`,
          [item.id, delta],
        )
      ).rows[0]!;
      await this.repo.takeList(db, listId, a.operatorId);
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'MANUAL', 'manual', delta);
      await this.repo.startBatch(db, listId);
      await this.repo.refreshListStatus(db, listId);
      return { status: r.status === 'complete' ? 'complete' : 'ok', item: toItem(r) };
    });
    if (result.status === 'complete' && result.item.labelsReady) result.print = await this.print(a, listId, result.item.sku).catch(() => null);
    return result;
  }

  async setNotes(a: Actor, itemId: string, notes: string | null) {
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('UPDATE wms_items SET notes = $2 WHERE id = $1', [itemId, notes || null]);
      if (!r.rowCount) throw new NotFoundError('Item não encontrado');
    });
  }

  /** Item ainda não começado vai para uma lista nova (EXT-…) de quem pediu. */
  async transfer(a: Actor, itemId: string): Promise<{ listId: string; code: string }> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const item = await this.repo.item(db, itemId);
      if (!item) throw new NotFoundError('Item não encontrado');
      if (item.qty_picked > 0) throw new Blocked('Esse item já tem unidades bipadas: não dá para transferir.');
      const old = (await this.repo.list(db, item.list_id, true))!;
      const code = `EXT-${old.code}-${Date.now().toString().slice(-4)}`;
      const list = (
        await db.query<{ id: string }>(
          `INSERT INTO wms_lists (tenant_id, batch_id, code, marketplace, operator_id) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
          [a.tenantId, old.batch_id, code, old.marketplace, a.operatorId],
        )
      ).rows[0]!;
      await db.query('UPDATE wms_items SET list_id = $2 WHERE id = $1', [itemId, list.id]);
      await this.repo.refreshListStatus(db, old.id);
      return { listId: list.id, code };
    });
  }

  /** Lista volta a ficar livre (sem dono), mantendo o que já foi bipado. */
  async release(a: Actor, listId: string) {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query(
        `UPDATE wms_lists SET operator_id = NULL,
                status = CASE WHEN EXISTS (SELECT 1 FROM wms_items WHERE list_id = $1 AND qty_picked > 0) THEN status ELSE 'open' END
          WHERE id = $1`,
        [listId],
      );
      if (!r.rowCount) throw new NotFoundError('Lista não encontrada');
    });
  }

  async deleteList(a: Actor, listId: string) {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('DELETE FROM wms_lists WHERE id = $1', [listId]);
      if (!r.rowCount) throw new NotFoundError('Lista não encontrada');
    });
  }

  /** Vincula um código novo ao SKU (operador: só se o SKU ainda não tem código; Análise/MASTER: sempre). */
  async linkBarcode(a: Actor, barcode: string, sku: string) {
    await this.db.withTenant(a.tenantId, async (db) => {
      const free = a.mode === 'analise' || a.master;
      if (!free && (await this.repo.realCodeCount(db, sku)) > 0) {
        throw new ForbiddenError('Esse SKU já tem código cadastrado. Peça para a Análise corrigir no Master Data.');
      }
      if (barcode.trim().toUpperCase() === sku.trim().toUpperCase()) throw new ValidationError('O SKU não vale como código de barras.');
      await this.repo.upsertProduct(db, a.tenantId, sku, null);
      await this.repo.addCode(db, a.tenantId, barcode, sku, a.operatorId);
    });
  }

  /** Busca do operador por EAN/código, SKU ou título em todas as listas. */
  async find(a: Actor, marketplace: WmsMarketplace, q: string): Promise<WmsFindDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const code = q.trim();
      let skus = await this.repo.skusForCode(db, code);
      const mp = 'l.marketplace = $2';
      if (!skus.length) {
        const found = await this.repo.candidates(
          db,
          `${mp} AND (upper(i.sku) = upper($1) OR i.sku ILIKE '%' || $1 || '%' OR i.description ILIKE '%' || $1 || '%')`,
          [code, marketplace],
          `l.status = 'completed', upper(i.sku) = upper($1) DESC, i.qty_required DESC`,
        );
        if (!found.length) return { action: 'not_found', sku: null, match: null, candidates: [] };
        if (found[0]!.sku.toUpperCase() !== code.toUpperCase() && found.length > 1) {
          return { action: 'multiple', sku: null, match: null, candidates: found };
        }
        skus = [found[0]!.sku.toUpperCase()];
      }
      const open = await this.repo.candidates(db, `${mp} AND upper(i.sku) = ANY($1) AND l.status <> 'completed'`, [skus, marketplace], 'i.qty_required DESC');
      if (open.length > 1) return { action: 'multiple', sku: skus[0]!, match: null, candidates: open };
      if (!open.length) {
        const done = await this.repo.candidates(db, `${mp} AND upper(i.sku) = ANY($1)`, [skus, marketplace], 'l.created_at DESC');
        return done.length
          ? { action: 'already_done', sku: skus[0]!, match: done[0]!, candidates: [] }
          : { action: 'not_in_lists', sku: skus[0]!, match: null, candidates: [] };
      }
      const m = open[0]!;
      const owner = (await this.repo.list(db, m.listId))!.operator_id;
      const action: WmsFindDto['action'] = TERMINAL.has(m.status)
        ? 'already_done'
        : owner && owner !== a.operatorId
          ? m.qtyPicked === 0
            ? 'transfer_available'
            : 'in_progress_other'
          : 'open';
      return { action, sku: m.sku, match: m, candidates: [] };
    });
  }

  /** "SKU faltantes": todo item ainda não começado nas listas abertas. */
  async pending(tenantId: string, marketplace: WmsMarketplace) {
    return this.db.withTenant(tenantId, (db) =>
      this.repo.candidates(db, `l.marketplace = $1 AND l.status <> 'completed' AND i.status = 'pending'`, [marketplace], 'i.qty_required - i.qty_picked DESC'),
    );
  }

  async shortages(tenantId: string, marketplace: WmsMarketplace): Promise<WmsShortageDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ sku: string; description: string; code: string; qty: number; notes: string | null }>(
        `SELECT i.sku, i.description, l.code, sum(i.shortage_qty)::int AS qty, string_agg(DISTINCT i.notes, ', ') AS notes
           FROM wms_items i JOIN wms_lists l ON l.id = i.list_id
           LEFT JOIN wms_batches b ON b.id = l.batch_id
          WHERE i.shortage_qty > 0 AND l.marketplace = $1 AND (b.id IS NULL OR b.status = 'active')
          GROUP BY i.sku, i.description, l.code ORDER BY 4 DESC, 1`,
        [marketplace],
      );
      return rows.map((r) => ({ sku: r.sku, description: r.description, listCode: r.code, qty: r.qty, notes: r.notes }));
    });
  }

  // ================= Etiquetas
  /** Gera o ZPL do item (Código ML na etiqueta) e põe na fila do agente. Sem `qty`: as unidades separadas. */
  async print(a: Actor, listId: string, sku: string, qty?: number): Promise<WmsPrintJobDto> {
    const job = await this.db.withTenant(a.tenantId, async (db) => {
      const list = await this.repo.list(db, listId);
      if (!list) throw new NotFoundError('Lista não encontrada');
      const item = await this.repo.itemBySku(db, listId, sku);
      if (!item) throw new NotFoundError('Item não encontrado nesta lista');
      const n = qty ?? Math.max(1, item.qty_picked);
      const zpl = buildLabelsZpl({ marketplace: list.marketplace, code: item.ml_code || item.sku, description: item.description, sku: item.sku, qty: n });
      // erro anterior sai; job já na fila/imprimindo não duplica
      await db.query(`DELETE FROM wms_print_jobs WHERE list_id = $1 AND upper(sku) = upper($2) AND status = 'ERROR'`, [listId, item.sku]);
      const busy = (
        await db.query<PrintRow>(
          `SELECT * FROM wms_print_jobs WHERE list_id = $1 AND upper(sku) = upper($2) AND status IN ('PENDING', 'PRINTING') LIMIT 1`,
          [listId, item.sku],
        )
      ).rows[0];
      if (busy?.status === 'PRINTING') return toJob(busy);
      if (busy) {
        return toJob((await db.query<PrintRow>('UPDATE wms_print_jobs SET zpl = $2, labels = $3 WHERE id = $1 RETURNING *', [busy.id, zpl, n])).rows[0]!);
      }
      return toJob(
        (
          await db.query<PrintRow>(
            `INSERT INTO wms_print_jobs (tenant_id, list_id, sku, zpl, labels, operator_id) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
            [a.tenantId, listId, item.sku, zpl, n, a.operatorId],
          )
        ).rows[0]!,
      );
    });
    await this.hub.dispatch(a.tenantId).catch(() => undefined);
    return job;
  }

  async printStatus(tenantId: string, listId: string, sku: string) {
    return this.db.withTenant(tenantId, (db) => this.repo.printJob(db, listId, sku));
  }

  /** ZPL para baixar (impressão sem agente: mandar o arquivo direto para a Zebra). */
  async zpl(tenantId: string, listId: string, sku: string, qty?: number): Promise<string> {
    return this.db.withTenant(tenantId, async (db) => {
      const list = await this.repo.list(db, listId);
      const item = list ? await this.repo.itemBySku(db, listId, sku) : null;
      if (!list || !item) throw new NotFoundError('Item não encontrado');
      return buildLabelsZpl({ marketplace: list.marketplace, code: item.ml_code || item.sku, description: item.description, sku: item.sku, qty: qty ?? Math.max(1, item.qty_picked) });
    });
  }

  async agentStatus(tenantId: string): Promise<WmsAgentStatusDto> {
    const { rows } = await this.db.query<{ key_hint: string; created_at: Date; last_seen_at: Date | null }>(
      'SELECT key_hint, created_at, last_seen_at FROM wms_print_agent_keys WHERE tenant_id = $1 ORDER BY created_at DESC',
      [tenantId],
    );
    return {
      connected: this.hub.connected(tenantId),
      keys: rows.map((r) => ({ hint: r.key_hint, createdAt: r.created_at.toISOString(), lastSeenAt: r.last_seen_at?.toISOString() ?? null })),
    };
  }

  /** Nova chave do agente (aparece uma única vez). As anteriores param de valer. */
  async newAgentKey(a: Actor): Promise<{ key: string }> {
    this.analysis(a);
    const key = newAgentKey();
    await this.db.query('DELETE FROM wms_print_agent_keys WHERE tenant_id = $1', [a.tenantId]);
    await this.db.query('INSERT INTO wms_print_agent_keys (key_hash, tenant_id, key_hint) VALUES ($1, $2, $3)', [
      hashAgentKey(key),
      a.tenantId,
      `${key.slice(0, 9)}…${key.slice(-4)}`,
    ]);
    return { key };
  }

  // ================= Master Data
  private masterData(a: Actor) {
    if (a.mode !== 'analise' && !a.master) throw new ForbiddenError('O Master Data é editado pela Análise (ou por um MASTER).');
  }

  async products(tenantId: string, q: string, page: number): Promise<WmsProductPageDto> {
    return this.db.withTenant(tenantId, (db) => this.repo.products(db, q, 50, (page - 1) * 50));
  }

  async product(tenantId: string, sku: string): Promise<WmsProductDto> {
    const r = await this.db.withTenant(tenantId, (db) => this.repo.products(db, sku, 50, 0));
    const p = r.items.find((x) => x.sku === sku.toUpperCase());
    if (!p) throw new NotFoundError('Produto não encontrado');
    return p;
  }

  async createProduct(a: Actor, input: { sku: string; description?: string; codes: string[] }): Promise<WmsProductDto> {
    this.masterData(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query(
        `INSERT INTO wms_products (tenant_id, sku, description) VALUES ($1, $2, nullif($3, '')) ON CONFLICT DO NOTHING`,
        [a.tenantId, input.sku, input.description ?? ''],
      );
      if (!r.rowCount) throw new ConflictError(`O SKU ${input.sku} já existe.`);
      for (const c of input.codes) await this.repo.addCode(db, a.tenantId, c, input.sku, a.operatorId);
    });
    return this.product(a.tenantId, input.sku);
  }

  async updateProduct(a: Actor, sku: string, p: { description?: string | null; noPhysicalBarcode?: boolean }): Promise<WmsProductDto> {
    this.masterData(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query(
        `UPDATE wms_products SET description = CASE WHEN $2 THEN nullif($3, '') ELSE description END,
                no_physical_barcode = coalesce($4, no_physical_barcode), updated_at = now()
          WHERE sku = upper($1)`,
        [sku, p.description !== undefined, p.description ?? '', p.noPhysicalBarcode ?? null],
      );
      if (!r.rowCount) throw new NotFoundError('Produto não encontrado');
    });
    return this.product(a.tenantId, sku);
  }

  async deleteProduct(a: Actor, sku: string) {
    this.masterData(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      await db.query('DELETE FROM wms_barcodes WHERE upper(sku) = upper($1)', [sku]);
      const r = await db.query('DELETE FROM wms_products WHERE sku = upper($1)', [sku]);
      if (!r.rowCount) throw new NotFoundError('Produto não encontrado');
    });
  }

  async addProductCode(a: Actor, sku: string, code: string): Promise<{ product: WmsProductDto; alsoOn: string[] }> {
    this.masterData(a);
    if (code.trim().toUpperCase() === sku.toUpperCase()) throw new ValidationError('O SKU não vale como código de barras.');
    const alsoOn = await this.db.withTenant(a.tenantId, async (db) => {
      if (!(await db.query('SELECT 1 FROM wms_products WHERE sku = upper($1)', [sku])).rowCount) throw new NotFoundError('Produto não encontrado');
      // o mesmo código pode estar em outro SKU (kits): avisa, para conferir se não foi vínculo errado
      const others = (await this.repo.skusForCode(db, code)).filter((s) => s !== sku.toUpperCase());
      await this.repo.addCode(db, a.tenantId, code, sku, a.operatorId);
      return others;
    });
    return { product: await this.product(a.tenantId, sku), alsoOn };
  }

  async removeProductCode(a: Actor, sku: string, code: string): Promise<WmsProductDto> {
    this.masterData(a);
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('DELETE FROM wms_barcodes WHERE upper(sku) = upper($1) AND barcode = $2', [sku, code]);
      if (!r.rowCount) throw new NotFoundError('Código não encontrado neste SKU');
    });
    return this.product(a.tenantId, sku);
  }

  /** Planilha (CSV) SKU;Descrição;EAN1;EAN2;EAN3 — soma ao cadastro, não apaga nada. */
  async importProducts(a: Actor, csv: string): Promise<{ products: number; codes: number }> {
    this.masterData(a);
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
    let products = 0;
    let codes = 0;
    await this.db.withTenant(a.tenantId, async (db) => {
      for (const [i, line] of lines.entries()) {
        const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
        const sku = (cols[0] ?? '').toUpperCase();
        if (!sku || (i === 0 && /^sku$/i.test(sku))) continue;
        const [desc, ...eans] = cols.length <= 2 ? [null, cols[1]] : [cols[1], ...cols.slice(2, 5)];
        await this.repo.upsertProduct(db, a.tenantId, sku, desc && !/^(n\/a|none)$/i.test(desc) ? desc : null);
        products++;
        for (const e of eans) {
          if (e && !/^(n\/a|none)$/i.test(e) && e.toUpperCase() !== sku && (await this.repo.addCode(db, a.tenantId, e, sku, a.operatorId, true))) codes++;
        }
      }
    });
    return { products, codes };
  }
}
