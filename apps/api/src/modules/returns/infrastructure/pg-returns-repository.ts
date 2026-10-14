import type {
  ReturnCheckDto,
  ReturnClass,
  ReturnDestination,
  ReturnDisputeDto,
  ReturnEvidenceDto,
  ReturnReason,
  ReturnResponsible,
  ReturnStage,
  MediationResult,
} from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { normalizeCode } from '../domain/codes.js';
import type { ReturnRecord } from '../domain/normalize.js';

export interface ReturnRow {
  id: string;
  external_id: string;
  order_id: string;
  pack_id: string | null;
  tracking: string | null;
  stage: ReturnStage;
  platform_status: string;
  in_mediation: boolean;
  can_dispute: boolean;
  awaiting_review: boolean;
  reason: ReturnReason;
  reason_platform: string;
  responsible: ReturnResponsible;
  destination: ReturnDestination;
  platform_cost: string | null;
  affects_reputation: boolean | null;
  product_condition: string | null;
  mediation_result: MediationResult | null;
  coverage_applied: boolean | null;
  seller_deadline: Date | null;
  items: { itemId: string | null; variationId?: string | null; sku: string | null; name: string | null; qty: number }[];
  opened_at: Date;
  updated_at: Date;
  // conferência (LEFT JOIN)
  c_class: ReturnClass | null;
  c_product_correct: boolean | null;
  c_complete: boolean | null;
  c_unused: boolean | null;
  c_resellable: boolean | null;
  c_our_error: boolean | null;
  c_sku_received: string | null;
  c_note: string | null;
  c_stock_moves: ReturnCheckDto['stockMoves'] | null;
  c_dispute: boolean | null;
  c_decision: string | null;
  c_manual_ticket: boolean | null;
  c_ticket_opened_at: Date | null;
  c_ticket_protocol: string | null;
  c_product_loss: string | null;
  c_reverse_freight: string | null;
  c_stock_done_at: Date | null;
  c_checked_by: string | null;
  c_checked_at: Date | null;
  c_stock_result: unknown[] | null;
  sale_logistic: string | null;
  mediation_opened_by: string | null;
  mediation_actions: string | null;
  disputed: boolean;
  accepted: boolean;
}

const SELECT = `
  SELECT r.id, r.external_id, r.order_id, r.pack_id, r.tracking, r.stage, r.platform_status, r.in_mediation, r.can_dispute,
         r.awaiting_review, r.reason, r.reason_platform, r.responsible, r.destination, r.platform_cost, r.affects_reputation,
         r.product_condition, r.mediation_result, r.coverage_applied, r.seller_deadline, r.items, r.opened_at, r.updated_at,
         c.class AS c_class, c.product_correct AS c_product_correct, c.complete AS c_complete, c.unused AS c_unused,
         c.resellable AS c_resellable, c.our_error AS c_our_error, c.sku_received AS c_sku_received, c.note AS c_note,
         c.stock_moves AS c_stock_moves, c.dispute AS c_dispute, c.decision AS c_decision, c.manual_ticket AS c_manual_ticket,
         c.ticket_opened_at AS c_ticket_opened_at, c.ticket_protocol AS c_ticket_protocol, c.product_loss AS c_product_loss,
         c.reverse_freight AS c_reverse_freight, c.stock_done_at AS c_stock_done_at, o.name AS c_checked_by, c.checked_at AS c_checked_at,
         c.stock_result AS c_stock_result, r.sale_logistic, r.mediation_opened_by, r.mediation_actions,
         EXISTS (SELECT 1 FROM return_disputes d WHERE d.return_id = r.id AND d.ok) AS disputed,
         EXISTS (SELECT 1 FROM return_disputes d WHERE d.return_id = r.id AND d.ok AND d.path = 'aceite') AS accepted
    FROM returns r
    LEFT JOIN return_checks c ON c.return_id = r.id
    LEFT JOIN operators o ON o.id = c.checked_by`;

export class PgReturnsRepository {
  /** Grava a foto do ML (nunca toca na conferência) e troca os códigos que vieram da sincronização. */
  async upsert(db: Queryable, tenantId: string, accountId: string | null, r: ReturnRecord): Promise<void> {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO returns (tenant_id, account_id, external_id, order_id, pack_id, tracking, stage, platform_status, in_mediation,
                            can_dispute, awaiting_review, reason, reason_platform, responsible, destination, platform_cost,
                            affects_reputation, product_condition, mediation_result, coverage_applied, seller_deadline, items,
                            opened_at, updated_at, raw, synced_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25, now())
       ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE SET
         account_id = EXCLUDED.account_id, order_id = EXCLUDED.order_id, pack_id = EXCLUDED.pack_id, tracking = EXCLUDED.tracking,
         stage = EXCLUDED.stage, platform_status = EXCLUDED.platform_status, in_mediation = EXCLUDED.in_mediation,
         can_dispute = EXCLUDED.can_dispute, awaiting_review = EXCLUDED.awaiting_review, reason = EXCLUDED.reason,
         reason_platform = EXCLUDED.reason_platform, responsible = EXCLUDED.responsible, destination = EXCLUDED.destination,
         platform_cost = EXCLUDED.platform_cost, affects_reputation = EXCLUDED.affects_reputation,
         product_condition = EXCLUDED.product_condition, mediation_result = EXCLUDED.mediation_result,
         coverage_applied = EXCLUDED.coverage_applied, seller_deadline = EXCLUDED.seller_deadline, items = EXCLUDED.items,
         opened_at = EXCLUDED.opened_at, updated_at = EXCLUDED.updated_at, raw = EXCLUDED.raw, synced_at = now()
       RETURNING id`,
      [
        tenantId, accountId, r.externalId, r.orderId, r.packId, r.tracking, r.stage, r.platformStatus, r.inMediation,
        r.canDispute, r.awaitingReview, r.reason, r.reasonPlatform, r.responsible, r.destination, r.platformCost,
        r.affectsReputation, r.productCondition, r.mediationResult, r.coverageApplied, r.sellerDeadline, JSON.stringify(r.items),
        r.openedAt, r.updatedAt, JSON.stringify(r.raw),
      ],
    );
    const id = rows[0]!.id;
    await db.query(`DELETE FROM return_codes WHERE return_id = $1 AND origin = 'mercado_livre'`, [id]);
    await this.addCodes(db, tenantId, id, r.codes, 'mercado_livre');
  }

  async addCodes(db: Queryable, tenantId: string, returnId: string, codes: string[], origin: string) {
    const unique = [...new Set(codes.filter((c) => c && String(c).trim()).map(normalizeCode))];
    if (!unique.length) return;
    await db.query(
      `INSERT INTO return_codes (tenant_id, code, return_id, origin) SELECT $1, unnest($2::text[]), $3, $4 ON CONFLICT DO NOTHING`,
      [tenantId, unique, returnId, origin],
    );
  }

  async idsByCodes(db: Queryable, codes: string[]): Promise<string[]> {
    const targets = [...new Set(codes.map(normalizeCode))];
    if (!targets.length) return [];
    const { rows } = await db.query<{ return_id: string }>('SELECT DISTINCT return_id FROM return_codes WHERE code = ANY($1)', [targets]);
    return rows.map((r) => r.return_id);
  }

  async rows(db: Queryable, where = 'TRUE', params: unknown[] = []): Promise<ReturnRow[]> {
    const { rows } = await db.query<ReturnRow>(`${SELECT} WHERE ${where}`, params);
    return rows;
  }

  async raw(db: Queryable, id: string): Promise<{ external_id: string; account_id: string | null; raw: Record<string, unknown> } | null> {
    const { rows } = await db.query<{ external_id: string; account_id: string | null; raw: Record<string, unknown> }>(
      'SELECT external_id, account_id, raw FROM returns WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }

  /** Fotos dos anúncios pelo id do item (catálogo de anúncios já sincronizado; nada de chamar o ML). */
  async pictures(db: Queryable, itemIds: string[]): Promise<Map<string, string>> {
    if (!itemIds.length) return new Map();
    const { rows } = await db.query<{ external_id: string; picture_url: string }>(
      `SELECT external_id, picture_url FROM listings WHERE external_id = ANY($1) AND picture_url IS NOT NULL`,
      [itemIds],
    );
    return new Map(rows.map((r) => [r.external_id, r.picture_url]));
  }

  /** Custo do SKU vigente na data (histórico do Cadastro de SKUs; antes do 1º registro vale o 1º). */
  async costAt(db: Queryable, sku: string | null, at: Date): Promise<number | null> {
    if (!sku) return null;
    const { rows } = await db.query<{ c: string | null }>(
      `SELECT coalesce(
         (SELECT custo_unit FROM sku_cost_history WHERE sku = $1 AND vigente_desde <= $2::date ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 1),
         (SELECT custo_unit FROM sku_cost_history WHERE sku = $1 ORDER BY vigente_desde, registrado_em LIMIT 1),
         (SELECT custo_unit FROM sku_costs WHERE sku = $1)) AS c`,
      [sku, at],
    );
    return rows[0]?.c == null ? null : Number(rows[0].c);
  }

  async evidence(db: Queryable, returnId: string): Promise<ReturnEvidenceDto[]> {
    const { rows } = await db.query<{ id: string; mime: string; size: number; added_at: Date }>(
      'SELECT id, mime, size, added_at FROM return_evidence WHERE return_id = $1 ORDER BY added_at',
      [returnId],
    );
    return rows.map((r) => ({ id: r.id, mime: r.mime, size: r.size, addedAt: r.added_at.toISOString() }));
  }

  async disputes(db: Queryable, returnId: string): Promise<ReturnDisputeDto[]> {
    const { rows } = await db.query<{
      id: string; reason: string; message: string; ok: boolean; path: string | null; warning: string | null; error: string | null; sent_at: Date; name: string | null;
    }>(
      `SELECT d.id, d.reason, d.message, d.ok, d.path, d.warning, d.error, d.sent_at, o.name
         FROM return_disputes d LEFT JOIN operators o ON o.id = d.sent_by WHERE d.return_id = $1 ORDER BY d.sent_at DESC`,
      [returnId],
    );
    return rows.map((r) => ({
      id: r.id, reason: r.reason, message: r.message, ok: r.ok, path: r.path, warning: r.warning, error: r.error,
      sentAt: r.sent_at.toISOString(), sentBy: r.name,
    }));
  }
}
