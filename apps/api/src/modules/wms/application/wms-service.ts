import {
  WMS_LIST_MAX_UNITS,
  WMS_MAX_ACTIVE_BATCHES,
  type WmsBatchDto,
  type WmsFindDto,
  type WmsInboundResultDto,
  type WmsItemDto,
  type WmsListDetailDto,
  type WmsListSummaryDto,
  type WmsMarketplace,
  type WmsOverviewDto,
  type WmsPrinterStatusDto,
  type WmsProductDto,
  type WmsProductPageDto,
  type WmsRankingDto,
  type WmsScanResultDto,
  type WmsSettingsDto,
  type WmsShortageDto,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import { parseInboundText, splitIntoLists, type InboundItem } from '../domain/ml-inbound-pdf.js';
import { parseShopeeInboundText } from '../domain/shopee-inbound-pdf.js';
import { buildLabelsPdf, type LabelSpec } from '../domain/label-pdf.js';

const TZ = 'America/Sao_Paulo';
/** SKU reservado da etiqueta de teste (não pertence a lista nenhuma). */
const TEST_SKU = 'TESTE-IMPRESSORA';
/** Empresa sem configuração salva: rolo de 1 coluna de 50 × 25 mm. */
const DEFAULT_SETTINGS: WmsSettingsDto = { labelFormat: 'rolo_1col', labelWidthMm: 50, labelHeightMm: 25 };
import { extractPdfText } from '../infrastructure/pdf-text.js';
import { sortLists, toItem, type ItemRow, type ListRow, type PgWmsRepository } from '../infrastructure/pg-wms-repository.js';

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
/** Leitura dupla do leitor de código ("KRKY38598KRKY38598") vira o código uma vez só. */
const undoubled = (code: string | undefined) => {
  const c = (code ?? '').trim();
  const h = c.length / 2;
  return c.length >= 8 && c.length % 2 === 0 && c.slice(0, h) === c.slice(h) ? c.slice(0, h) : c;
};

/**
 * Supervisão Full (portado do NVS-WMS): envio do Full (PDF do ML) → lote → listas de até 1.000 unidades →
 * o operador bipa (unidade ou caixa), marca falta/sem estoque e imprime as etiquetas em PDF (qualquer impressora) ao concluir o item.
 * Regra de ouro do NVS-WMS: quem bipa vira dono da lista; item de outra pessoa só passa por transferência.
 */
export class WmsService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgWmsRepository,
  ) {}

  // ================= Processamento (Análise)
  async inbound(
    a: Actor,
    input: { marketplace: WmsMarketplace; fullDate: string; pdfBase64: string; archiveOldestId?: string },
  ): Promise<WmsInboundResultDto> {
    if (a.mode !== 'analise') throw new ForbiddenError('O Processamento é feito pela Análise.');
    const pdf = Buffer.from(input.pdfBase64, 'base64');
    if (pdf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new ValidationError('O arquivo não é um PDF.');
    let texts;
    try {
      texts = await extractPdfText(new Uint8Array(pdf));
    } catch {
      throw new ValidationError('Não foi possível ler o PDF. Use o PDF do envio Full baixado do Mercado Livre ou da Shopee.');
    }
    // o próprio PDF diz de onde é: "Shopee Picking List" / ASN INBRFSP… é Shopee; o resto, Mercado Livre
    const isShopee = texts.some((t) => /Shopee Picking List|INBRFSP\d+/.test(t.str));
    const marketplace: WmsMarketplace = isShopee ? 'shopee' : 'ml';
    const parsed = isShopee ? parseShopeeInboundText(texts) : parseInboundText(texts);
    if (!parsed.items.length) {
      throw new ValidationError(
        isShopee
          ? 'Nenhum produto encontrado no PDF da Shopee. É o "Shopee Picking List" do envio Full?'
          : 'Nenhum produto encontrado no PDF. É o PDF "Lista de produtos e instruções de preparação" do envio Full?',
      );
    }
    const units = parsed.items.reduce((s, i) => s + i.qty, 0);
    // Shopee: a conta tem que fechar com o rodapé (o PDF dela tem bugs de impressão; melhor recusar que errar)
    if (isShopee && parsed.declaredUnits !== null && parsed.declaredUnits !== units) {
      const diff = parsed.declaredUnits - units;
      throw new ValidationError(
        `A conta não fecha: somei ${units} peças e a Shopee declara ${parsed.declaredUnits} no rodapé (${diff > 0 ? `faltam ${diff}` : `sobram ${-diff}`}). Confira o PDF ou envie para o suporte.`,
      );
    }

    return this.db.withTenant(a.tenantId, async (db) => {
      // vários lotes ao mesmo tempo, com limite: o mais antigo é arquivado (pedindo confirmação se tiver pendência)
      const active = (
        await db.query<{ id: string; name: string }>(
          `SELECT id, name FROM wms_batches WHERE status = 'active' AND marketplace = $1 ORDER BY full_date, seq FOR UPDATE`,
          [marketplace],
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
          marketplace,
          input.fullDate,
        ])).rows[0]!.n + 1;
      const dateBr = ddmmyyyy(input.fullDate).replace(/-/g, '/');
      const name = seq === 1 ? dateBr : `${dateBr} · nº${seq}`;
      const batch = (
        await db.query<{ id: string }>(
          `INSERT INTO wms_batches (tenant_id, marketplace, full_date, seq, name, inbound_ref, created_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
          [a.tenantId, marketplace, input.fullDate, seq, name, parsed.ref, a.operatorId],
        )
      ).rows[0]!;

      const prefix = `${marketplace === 'shopee' ? 'SH' : 'ML'}-${ddmmyyyy(input.fullDate)}${seq > 1 ? `-${String.fromCharCode(64 + seq)}` : ''}`;
      const groups = splitIntoLists(parsed.items, WMS_LIST_MAX_UNITS);
      for (const [i, group] of groups.entries()) {
        const code = groups.length > 1 ? `${prefix}-L${String(i + 1).padStart(2, '0')}` : prefix;
        const list = (
          await db.query<{ id: string }>(
            `INSERT INTO wms_lists (tenant_id, batch_id, code, marketplace) VALUES ($1, $2, $3, $4) RETURNING id`,
            [a.tenantId, batch.id, code, marketplace],
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
      const [dto] = await this.repo.batches(db, marketplace, batch.id);
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
                 FROM wms_items WHERE list_id = ANY($1) AND shortage_status = 'pendente'`,
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

  async scan(a: Actor, listId: string, input: { barcode: string; focusSku?: string; mode: 'unit' | 'box' | 'qty'; qty?: number }): Promise<WmsScanResultDto> {
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

      const left = item.qty_required - item.qty_picked;
      const want = input.mode === 'unit' ? 1 : Math.min(input.qty ?? left, left);
      if (want <= 0) {
        // quantidade zero = sem estoque; caixa vazia não muda nada
        if (input.mode === 'qty') return this.outOfStockIn(db, a, list, item, 'Nenhuma unidade encontrada');
        return { status: 'ok', item: toItem(item) };
      }
      const upd = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = qty_picked + $2, status = 'in_progress'
            WHERE id = $1 AND qty_picked + $2 <= qty_required RETURNING *`,
          [item.id, want],
        )
      ).rows[0];
      if (!upd) return { status: 'excess', item: toItem((await this.repo.item(db, item.id))!) };
      await this.repo.takeList(db, listId, a.operatorId);
      await this.repo.event(db, a.tenantId, listId, upd.id, a.operatorId, code, input.mode === 'unit' ? 'scan' : `scan_${input.mode}`, want);
      await this.repo.startBatch(db, listId);

      // modo quantidade: o que foi informado é tudo o que tem; o resto vira falta e as etiquetas saem só para o encontrado
      const short = input.mode === 'qty' && upd.qty_picked < upd.qty_required;
      if (upd.qty_picked >= upd.qty_required || short) {
        const done = (
          await db.query<ItemRow>(
            `UPDATE wms_items SET status = $2, shortage_qty = qty_required - qty_picked, completed_at = now(),
                    shortage_status = 'pendente', shortage_at = CASE WHEN qty_required > qty_picked THEN now() END, shortage_by = $3
              WHERE id = $1 RETURNING *`,
            [upd.id, upd.qty_picked >= upd.qty_required ? 'complete' : 'partial', a.operatorId],
          )
        ).rows[0]!;
        await this.repo.refreshListStatus(db, listId);
        return { status: 'complete', item: toItem(done) };
      }
      return { status: 'ok', item: toItem(upd) };
    });
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
      // desfaz a última bipada inteira (uma caixa de 50 volta as 50), pulando as já desfeitas
      const events = (
        await db.query<{ event_type: string; qty_delta: number }>(
          `SELECT event_type, qty_delta FROM wms_scan_events WHERE item_id = $1 ORDER BY id DESC LIMIT 500`,
          [item.id],
        )
      ).rows;
      let undone = 0;
      let delta = 1;
      for (const e of events) {
        if (e.event_type === 'undo') undone++;
        else if (e.qty_delta > 0 && undone > 0) undone--;
        else if (e.qty_delta > 0) {
          delta = e.qty_delta;
          break;
        }
      }
      delta = Math.min(delta, item.qty_picked);
      const r = (
        await db.query<ItemRow>(
          `UPDATE wms_items SET qty_picked = qty_picked - $2, shortage_qty = 0, completed_at = NULL,
                  status = CASE WHEN qty_picked - $2 = 0 THEN 'pending' ELSE 'in_progress' END
            WHERE id = $1 RETURNING *`,
          [item.id, delta],
        )
      ).rows[0]!;
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'UNDO', 'undo', -delta);
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
                  status = CASE WHEN $2 >= qty_required THEN 'complete' WHEN $2 = 0 THEN 'out_of_stock' ELSE 'partial' END,
                  shortage_status = 'pendente', shortage_at = now(), shortage_by = $4
            WHERE id = $1 RETURNING *`,
          [item.id, found, input.notes || null, a.operatorId],
        )
      ).rows[0]!;
      await this.repo.takeList(db, listId, a.operatorId);
      await this.repo.event(db, a.tenantId, listId, item.id, a.operatorId, 'SHORTAGE', 'shortage', found - item.qty_picked);
      await this.repo.startBatch(db, listId);
      await this.repo.refreshListStatus(db, listId);
      return { status: 'complete', item: toItem(r) };
    });
    return result;
  }

  async outOfStock(a: Actor, listId: string, input: { sku: string; notes?: string }): Promise<WmsScanResultDto> {
    const result = await this.db.withTenant(a.tenantId, async (db) => {
      const { list, item } = await this.ownItem(db, a, listId, input.sku);
      return this.outOfStockIn(db, a, list, item, input.notes);
    });
    return result;
  }

  private async outOfStockIn(db: Queryable, a: Actor, list: ListRow, item: ItemRow, notes?: string): Promise<WmsScanResultDto> {
    const r = (
      await db.query<ItemRow>(
        `UPDATE wms_items SET shortage_qty = qty_required - qty_picked, completed_at = now(), notes = coalesce($2, notes),
                status = CASE WHEN qty_picked > 0 THEN 'partial' ELSE 'out_of_stock' END,
                shortage_status = 'pendente', shortage_at = now(), shortage_by = $3
          WHERE id = $1 RETURNING *`,
        [item.id, notes || null, a.operatorId],
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

  /** Relatório de Faltas: toda falta registrada no picking (dos dois marketplaces), a mais recente primeiro. */
  async shortages(tenantId: string): Promise<WmsShortageDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{
        id: string; sku: string; description: string; list_id: string; code: string; batch: string | null; marketplace: WmsMarketplace;
        qty: number; notes: string | null; operator: string | null; at: Date | null; status: 'pendente' | 'concluido';
      }>(
        `SELECT i.id, i.sku, i.description, l.id AS list_id, l.code, b.name AS batch, l.marketplace, i.shortage_qty AS qty, i.notes,
                coalesce(o.name, lo.name) AS operator, coalesce(i.shortage_at, i.completed_at) AS at, i.shortage_status AS status
           FROM wms_items i JOIN wms_lists l ON l.id = i.list_id
           LEFT JOIN wms_batches b ON b.id = l.batch_id
           LEFT JOIN operators o ON o.id = i.shortage_by
           LEFT JOIN operators lo ON lo.id = l.operator_id
          WHERE i.shortage_qty > 0 AND i.shortage_status <> 'removido'
          ORDER BY coalesce(i.shortage_at, i.completed_at) DESC NULLS LAST, i.sku`,
      );
      return rows.map((r) => ({
        itemId: r.id, sku: r.sku, description: r.description, listId: r.list_id, listCode: r.code, batchName: r.batch, marketplace: r.marketplace,
        qty: r.qty, notes: r.notes, operatorName: r.operator, at: r.at ? r.at.toISOString() : null, status: r.status,
      }));
    });
  }

  /** Marca a falta como resolvida (reposta, comprada, ajustada no envio) ou volta para pendente. */
  async setShortageStatus(tenantId: string, itemId: string, status: 'pendente' | 'concluido') {
    await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query(`UPDATE wms_items SET shortage_status = $2 WHERE id = $1 AND shortage_qty > 0 AND shortage_status <> 'removido'`, [itemId, status]);
      if (!r.rowCount) throw new NotFoundError('Falta não encontrada');
    });
  }

  /** Tira do relatório (o histórico do picking continua igual). Sem `itemId`: tira todas. */
  async removeShortages(tenantId: string, itemId?: string): Promise<number> {
    return this.db.withTenant(tenantId, async (db) => {
      const r = itemId
        ? await db.query(`UPDATE wms_items SET shortage_status = 'removido' WHERE id = $1 AND shortage_qty > 0`, [itemId])
        : await db.query(`UPDATE wms_items SET shortage_status = 'removido' WHERE shortage_qty > 0 AND shortage_status <> 'removido'`);
      if (itemId && !r.rowCount) throw new NotFoundError('Falta não encontrada');
      return r.rowCount ?? 0;
    });
  }

  // ================= Etiquetas
  // ================= Configuração da impressão
  async settings(tenantId: string): Promise<WmsSettingsDto> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ label_format: WmsSettingsDto['labelFormat']; label_width_mm: string; label_height_mm: string }>(
        'SELECT label_format, label_width_mm, label_height_mm FROM wms_settings',
      ),
    );
    const r = rows[0];
    return r
      ? { labelFormat: r.label_format, labelWidthMm: Number(r.label_width_mm), labelHeightMm: Number(r.label_height_mm) }
      : DEFAULT_SETTINGS;
  }

  async saveSettings(a: Actor, input: WmsSettingsDto): Promise<WmsSettingsDto> {
    this.analysis(a);
    await this.db.withTenant(a.tenantId, (db) =>
      db.query(
        `INSERT INTO wms_settings (tenant_id, label_format, label_width_mm, label_height_mm) VALUES ($1, $2, $3, $4)
         ON CONFLICT (tenant_id) DO UPDATE SET label_format = EXCLUDED.label_format,
           label_width_mm = EXCLUDED.label_width_mm, label_height_mm = EXCLUDED.label_height_mm, updated_at = now()`,
        [a.tenantId, input.labelFormat, input.labelWidthMm, input.labelHeightMm],
      ),
    );
    return this.settings(a.tenantId);
  }

  /**
   * PDF das etiquetas no formato da empresa: de um SKU (`qty` ou o separado) ou, sem SKU, da lista inteira
   * (cada item com a quantidade separada).
   */
  async labelsPdf(tenantId: string, listId: string, sku?: string, qty?: number): Promise<Buffer> {
    const s = await this.settings(tenantId);
    const specs = await this.db.withTenant(tenantId, async (db) => {
      const list = await this.repo.list(db, listId);
      if (!list) throw new NotFoundError('Lista não encontrada');
      const items = sku ? [await this.repo.itemBySku(db, listId, sku)] : await this.repo.items(db, listId);
      if (sku && !items[0]) throw new NotFoundError('Item não encontrado nesta lista');
      return items
        .filter((i): i is ItemRow => Boolean(i))
        .map((i): LabelSpec => ({
          marketplace: list.marketplace,
          code: i.ml_code || i.sku,
          description: i.description,
          sku: i.sku,
          qty: sku ? (qty ?? Math.max(1, i.qty_picked)) : i.qty_picked,
        }))
        .filter((i) => i.qty > 0);
    });
    if (!specs.length) throw new ValidationError('Nenhuma etiqueta para imprimir: nada foi separado nesta lista ainda.');
    return buildLabelsPdf(specs, { format: s.labelFormat, widthMm: s.labelWidthMm, heightMm: s.labelHeightMm });
  }

  /** Impressão pelo navegador: o operador confirma que as etiquetas saíram. */
  async markPrinted(a: Actor, listId: string, sku: string): Promise<void> {
    await this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('UPDATE wms_items SET labels_printed = true WHERE list_id = $1 AND upper(sku) = upper($2)', [listId, sku]);
      if (!r.rowCount) throw new NotFoundError('Item não encontrado nesta lista');
    });
  }

  /** Etiqueta de teste em PDF (mesmo formato das do Full). */
  async testPdf(a: Actor): Promise<Buffer> {
    const s = await this.settings(a.tenantId);
    const name = await this.operatorName(a);
    const when = new Date().toLocaleString('pt-BR', { timeZone: TZ, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
    const qty = s.labelFormat === 'rolo_2col' ? 2 : 1;
    return buildLabelsPdf([{ marketplace: 'ml', code: 'TESTENVS', description: `ETIQUETA DE TESTE NVS - ${when} - ${name}`, sku: TEST_SKU, qty }], {
      format: s.labelFormat,
      widthMm: s.labelWidthMm,
      heightMm: s.labelHeightMm,
    });
  }

  // ================= Conferência da impressora (tela do operador)
  /**
   * Situação para a Operação: formato da etiqueta, conferência de hoje (etiqueta de teste confirmada por alguém do
   * turno) e se há Full em andamento (listas abertas) — só então a conferência é exigida.
   */
  async printerStatus(tenantId: string): Promise<WmsPrinterStatusDto> {
    const settings = await this.settings(tenantId);
    return this.db.withTenant(tenantId, async (db) => {
      const check = (
        await db.query<{ confirmed_by: string; confirmed_at: Date; printer_name: string | null }>(
          `SELECT confirmed_by, confirmed_at, printer_name FROM wms_printer_checks WHERE day = (now() AT TIME ZONE '${TZ}')::date`,
        )
      ).rows[0];
      const running = (await db.query(`SELECT 1 FROM wms_lists WHERE status <> 'completed' LIMIT 1`)).rowCount ?? 0;
      return {
        settings,
        checkedToday: check ? { by: check.confirmed_by, at: check.confirmed_at.toISOString(), format: check.printer_name } : null,
        fullRunning: running > 0,
      };
    });
  }

  /** "A etiqueta saiu legível": vale para o turno todo de hoje. */
  async confirmPrinter(a: Actor): Promise<void> {
    const name = await this.operatorName(a);
    const s = await this.settings(a.tenantId);
    await this.db.withTenant(a.tenantId, (db) =>
      db.query(
        `INSERT INTO wms_printer_checks (tenant_id, day, machine, printer_name, confirmed_by)
         VALUES ($1, (now() AT TIME ZONE '${TZ}')::date, $2, $3, $4)
         ON CONFLICT (tenant_id, day) DO UPDATE SET machine = EXCLUDED.machine, printer_name = EXCLUDED.printer_name,
           confirmed_by = EXCLUDED.confirmed_by, confirmed_at = now()`,
        [a.tenantId, 'navegador', `PDF ${s.labelWidthMm} × ${s.labelHeightMm} mm`, name],
      ),
    );
  }

  private async operatorName(a: Actor): Promise<string> {
    const { rows } = await this.db.withTenant(a.tenantId, (db) => db.query<{ name: string }>('SELECT name FROM operators WHERE id = $1', [a.operatorId]));
    return rows[0]?.name ?? 'Operador';
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

  /** Planilha (CSV) SKU;Descrição;EAN1;EAN2;… (quantos códigos tiver) — soma ao cadastro, não apaga nada. */
  async importProducts(a: Actor, csv: string, onlyListings = false): Promise<{ products: number; codes: number; skipped: number }> {
    this.masterData(a);
    let skipped = 0;
    const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter((l) => l.trim());
    const sep = (lines[0] ?? '').includes(';') ? ';' : ',';
    // com cabeçalho "Descrição", a 2ª coluna é sempre descrição; sem cabeçalho e só 2 colunas, é SKU;EAN
    const withDesc = /descri/i.test(lines[0] ?? '');
    let products = 0;
    let codes = 0;
    await this.db.withTenant(a.tenantId, async (db) => {
      // anúncios do ML da conta: SKU do anúncio e das variações → título
      const listings = new Map<string, string>();
      if (onlyListings) {
        const { rows } = await db.query<{ sku: string; title: string }>(
          `SELECT upper(s) AS sku, min(title) AS title FROM (
             SELECT sku AS s, title FROM listings WHERE sku IS NOT NULL AND marketplace = 'mercado_livre'
             UNION ALL SELECT unnest(variation_skus), title FROM listings WHERE marketplace = 'mercado_livre') x
            WHERE s <> '' GROUP BY 1`,
        );
        for (const r of rows) listings.set(r.sku.trim(), r.title);
      }
      for (const [i, line] of lines.entries()) {
        const cols = line.split(sep).map((c) => c.trim().replace(/^"|"$/g, ''));
        const sku = (cols[0] ?? '').toUpperCase();
        if (!sku || (i === 0 && /^sku$/i.test(sku))) continue;
        const [desc, ...eans] = !withDesc && cols.length <= 2 ? [null, cols[1]] : [cols[1], ...cols.slice(2, 52)];
        if (onlyListings && !listings.has(sku)) {
          skipped++;
          continue;
        }
        const clean = desc && !/^(n\/a|none)$/i.test(desc) ? desc : null;
        await this.repo.upsertProduct(db, a.tenantId, sku, clean ?? listings.get(sku) ?? null);
        products++;
        for (const raw of eans) {
          const e = undoubled(raw);
          if (e && !/^(n\/a|none)$/i.test(e) && e.toUpperCase() !== sku && (await this.repo.addCode(db, a.tenantId, e, sku, a.operatorId, true))) codes++;
        }
      }
    });
    return { products, codes, skipped };
  }

  /** Apaga todos os produtos e códigos do Master Data (a senha da conta é conferida na rota). */
  async clearProducts(a: Actor): Promise<{ products: number; codes: number }> {
    this.masterData(a);
    return this.db.withTenant(a.tenantId, async (db) => {
      const codes = (await db.query('DELETE FROM wms_barcodes')).rowCount ?? 0;
      const products = (await db.query('DELETE FROM wms_products')).rowCount ?? 0;
      return { products, codes };
    });
  }
}
