import {
  RETURN_STATUSES,
  type ReturnBiDto,
  type ReturnCheckDto,
  type ReturnCheckInput,
  type ReturnClass,
  type ReturnDetailDto,
  type ReturnListDto,
  type ReturnMoneyDto,
  type ReturnReason,
  type ReturnRowDto,
  type ReturnShipping,
  type ReturnStatus,
  type ReturnSummaryDto,
  type ReturnSyncDto,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import type { MlIntegrationService, MlRawApi } from '../../mercado-livre/index.js';
import { extractCodes } from '../domain/codes.js';
import { REVIEW_OK, sellerActions } from '../domain/normalize.js';
import { decide, pending, shipping, status, type CheckState } from '../domain/rules.js';
import type { PgReturnsRepository, ReturnRow } from '../infrastructure/pg-returns-repository.js';
import type { ReturnsSync } from './returns-sync.js';

export interface ReturnActor {
  tenantId: string;
  operatorId: string;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const round2 = (v: number) => Math.round(v * 100) / 100;
const PAGE = 30;
/** Motivo que já diz que o produto chegou quebrado (perda estimada pelo custo, sem conferência). */
const DECLARED_BROKEN = new Set<ReturnReason>(['danificado', 'defeito']);
const PHOTO_TYPES = new Map([['image/jpeg', 'jpg'], ['image/png', 'png'], ['image/webp', 'webp']]);
const PHOTO_MAX = 8 * 1024 * 1024;

class Locked extends AppError {
  constructor(message: string) {
    super(message, 'RETURN_LOCKED', 409);
  }
}

function checkState(r: ReturnRow): CheckState | null {
  if (!r.c_class) return null;
  return {
    stockMoves: r.c_stock_moves ?? [],
    stockDoneAt: r.c_stock_done_at,
    dispute: Boolean(r.c_dispute),
    manualTicket: Boolean(r.c_manual_ticket),
    ticketOpenedAt: r.c_ticket_opened_at,
  };
}

function checkDto(r: ReturnRow): ReturnCheckDto | null {
  if (!r.c_class) return null;
  return {
    class: r.c_class,
    productCorrect: Boolean(r.c_product_correct),
    complete: Boolean(r.c_complete),
    unused: Boolean(r.c_unused),
    resellable: Boolean(r.c_resellable),
    ourError: Boolean(r.c_our_error),
    skuReceived: r.c_sku_received,
    note: r.c_note,
    stockMoves: r.c_stock_moves ?? [],
    dispute: Boolean(r.c_dispute),
    decision: r.c_decision ?? '',
    manualTicket: Boolean(r.c_manual_ticket),
    ticketOpenedAt: iso(r.c_ticket_opened_at),
    ticketProtocol: r.c_ticket_protocol,
    productLoss: num(r.c_product_loss),
    reverseFreight: num(r.c_reverse_freight),
    stockDoneAt: iso(r.c_stock_done_at),
    checkedBy: r.c_checked_by,
    checkedAt: iso(r.c_checked_at)!,
  };
}

export function toRow(r: ReturnRow, pictures: Map<string, string> = new Map()): ReturnRowDto {
  const check = checkState(r);
  const st = status({ destination: r.destination, stage: r.stage, inMediation: r.in_mediation }, check, r.disputed, r.accepted);
  const cost = num(r.platform_cost);
  const loss = r.c_class ? round2((num(r.c_reverse_freight) ?? 0) + (num(r.c_product_loss) ?? 0)) : cost;
  return {
    id: r.id,
    externalId: r.external_id,
    orderId: r.order_id,
    packId: r.pack_id,
    tracking: r.tracking,
    stage: r.stage,
    platformStatus: r.platform_status,
    inMediation: r.in_mediation,
    canDispute: r.can_dispute,
    awaitingReview: r.awaiting_review,
    reason: r.reason,
    reasonPlatform: r.reason_platform,
    responsible: r.responsible,
    destination: r.destination,
    platformCost: cost,
    affectsReputation: r.affects_reputation,
    productCondition: r.product_condition,
    mediationResult: r.mediation_result,
    sellerDeadline: iso(r.seller_deadline),
    items: (r.items ?? []).map((i) => ({
      itemId: i.itemId,
      sku: i.sku,
      name: i.name,
      qty: i.qty,
      pictureUrl: (i.itemId && pictures.get(i.itemId)) || null,
    })),
    openedAt: r.opened_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
    status: st,
    pending: pending(check, r.disputed),
    shipping: st === 'a_caminho' ? shipping(r.platform_status) : null,
    check: checkDto(r),
    disputed: r.disputed,
    loss,
    link: `https://www.mercadolivre.com.br/vendas/${r.pack_id ?? r.order_id}/detalhe`,
  };
}

const emptyCounts = () => Object.fromEntries(RETURN_STATUSES.map((s) => [s, 0])) as Record<ReturnStatus, number>;
const emptyShipping = (): Record<ReturnShipping, number> => ({ aguardando_postagem: 0, postado: 0, sem_info: 0 });

/**
 * Central de Devoluções (portada do NOVAES-ESTOQUE, só Mercado Livre): fila da operação, resumo, B.I, bipe na bancada,
 * conferência (A/B/C), contestação/aceite no ML e chamados manuais. O trabalho do operador nunca é sobrescrito pela
 * sincronização (fica em return_checks / return_disputes).
 */
export class ReturnsService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgReturnsRepository,
    private readonly ml: MlIntegrationService,
    private readonly api: MlRawApi | null,
    private readonly sync: ReturnsSync | null,
  ) {}

  private async all(tenantId: string): Promise<ReturnRowDto[]> {
    return this.db.withTenant(tenantId, async (db) => (await this.repo.rows(db)).map((r) => toRow(r)));
  }

  private async withPictures(db: Queryable, rows: ReturnRowDto[]) {
    const pics = await this.repo.pictures(db, [...new Set(rows.flatMap((r) => r.items.map((i) => i.itemId)).filter((x): x is string => Boolean(x)))]);
    for (const r of rows) for (const i of r.items) i.pictureUrl = (i.itemId && pics.get(i.itemId)) || null;
    return rows;
  }

  // ================= fila / resumo
  async list(tenantId: string, q: { status?: string; reason?: string; shipping?: ReturnShipping; q?: string; page: number }): Promise<ReturnListDto> {
    const base = (await this.all(tenantId)).filter((r) => !q.reason || r.reason === q.reason);
    const counts = emptyCounts();
    const onTheWay = emptyShipping();
    for (const r of base) {
      counts[r.status]++;
      if (r.shipping) onTheWay[r.shipping]++;
    }
    let rows = base;
    if (q.status) {
      const wanted = new Set(q.status.split(','));
      rows = rows.filter((r) => wanted.has(r.status));
    }
    if (q.shipping) rows = rows.filter((r) => r.shipping === q.shipping);
    if (q.q?.trim()) {
      const t = q.q.trim().toLowerCase();
      rows = rows.filter((r) =>
        [r.orderId, r.packId, r.tracking, r.externalId, ...r.items.flatMap((i) => [i.sku, i.name])].some((v) => v?.toLowerCase().includes(t)),
      );
    }
    // prazo que ainda dá para cumprir, o mais apertado primeiro; o resto, mais recente primeiro
    const now = Date.now();
    const key = (r: ReturnRowDto) => (r.sellerDeadline && Date.parse(r.sellerDeadline) > now ? [0, Date.parse(r.sellerDeadline)] : [1, -Date.parse(r.updatedAt)]);
    rows.sort((a, b) => {
      const [ka, va] = key(a);
      const [kb, vb] = key(b);
      return ka! - kb! || va! - vb!;
    });
    const items = rows.slice((q.page - 1) * PAGE, q.page * PAGE);
    await this.db.withTenant(tenantId, (db) => this.withPictures(db, items));
    return { total: rows.length, counts, onTheWay, items };
  }

  async summary(tenantId: string): Promise<ReturnSummaryDto> {
    const rows = await this.all(tenantId);
    const counts = emptyCounts();
    const onTheWay = emptyShipping();
    const now = Date.now();
    const open = rows.filter((r) => r.status !== 'finalizada' && r.status !== 'com_a_plataforma');
    for (const r of rows) {
      counts[r.status]++;
      if (r.shipping) onTheWay[r.shipping]++;
    }
    const latest = [...rows].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt)).slice(0, 6);
    const [state, st] = await Promise.all([
      this.db.withTenant(tenantId, async (db) => {
        await this.withPictures(db, latest);
        return (await db.query<{ last_sync: Date }>('SELECT last_sync FROM return_sync_state')).rows[0] ?? null;
      }),
      this.ml.status(tenantId),
    ]);
    return {
      attention: {
        dispute: open.filter((r) => r.pending.includes('contestar')).length,
        manualTickets: open.filter((r) => r.pending.includes('chamado_manual')).length,
        stock: open.filter((r) => r.pending.includes('lancar_estoque')).length,
        awaitingCheck: open.filter((r) => r.status === 'aguardando_conferencia').length,
        deadline24h: open.filter((r) => r.sellerDeadline && Date.parse(r.sellerDeadline) >= now && Date.parse(r.sellerDeadline) <= now + 86_400_000).length,
      },
      counts,
      onTheWay,
      latest,
      lastSync: iso(state?.last_sync ?? null),
      connected: st.connections.some((c) => c.status === 'active'),
    };
  }

  /** Sincroniza agora (30 dias + todas as abertas). Roda em segundo plano: a tela acompanha pela data da última. */
  startSync(tenantId: string): { started: boolean } {
    if (!this.sync) throw new ValidationError('Integração com o Mercado Livre não configurada neste ambiente');
    void this.sync.syncTenant(tenantId, { days: 30, allOpen: true }).catch(() => undefined);
    return { started: true };
  }

  async syncNow(tenantId: string): Promise<ReturnSyncDto> {
    if (!this.sync) throw new ValidationError('Integração com o Mercado Livre não configurada neste ambiente');
    return this.sync.syncTenant(tenantId, { days: 30, allOpen: true });
  }

  // ================= B.I
  async bi(tenantId: string, days: number): Promise<ReturnBiDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const raw = await this.repo.rows(db, 'r.opened_at >= $1', [new Date(Date.now() - 2 * days * 86_400_000)]);
      const from = new Date(Date.now() - days * 86_400_000);
      const rows = raw.map((r) => ({ r, dto: toRow(r) }));
      const current = rows.filter((x) => x.r.opened_at >= from);
      const previous = rows.filter((x) => x.r.opened_at < from);

      // custo do produto (CMV) para a perda estimada pelo motivo; cache por SKU+dia
      const cache = new Map<string, number | null>();
      const costAt = async (sku: string | null, at: Date) => {
        const k = `${sku}|${at.toISOString().slice(0, 10)}`;
        if (!cache.has(k)) cache.set(k, await this.repo.costAt(db, sku, at));
        return cache.get(k)!;
      };
      const cmv = async (r: ReturnRow) => {
        if (!r.items?.length) return null;
        let total = 0;
        for (const i of r.items) {
          const c = await costAt(i.sku, r.opened_at);
          if (c === null) return null;
          total += c * (i.qty || 1);
        }
        return round2(total);
      };
      /** De onde vem a mercadoria quebrada e quanto custa: bancada (conferiu e não vende) ou motivo (já veio quebrado). */
      const loss = async (r: ReturnRow): Promise<[('bancada' | 'motivo') | null, number | null]> => {
        if (r.c_class) return r.c_class !== 'A' ? ['bancada', num(r.c_product_loss)] : [null, 0];
        if (DECLARED_BROKEN.has(r.reason) && r.stage !== 'cancelada') return ['motivo', await cmv(r)];
        return [null, 0];
      };
      const money = async (list: { r: ReturnRow }[]): Promise<ReturnMoneyDto> => {
        const m = { reverseFreight: 0, freightRefunded: 0, freightInMediation: 0, productLoss: 0, recovered: 0, withoutCost: 0 };
        for (const { r } of list) {
          const freight = num(r.platform_cost) ?? 0;
          m.reverseFreight += freight;
          if (r.mediation_result === 'em_andamento') m.freightInMediation += freight;
          if (r.mediation_result === 'ganha') {
            m.freightRefunded += freight;
            // mediação ganha tira a cobrança do frete; com cobertura, o ML também paga o produto
            m.recovered += freight + (r.coverage_applied ? ((await cmv(r)) ?? 0) : 0);
          }
          const [origin, value] = await loss(r);
          if (origin && value === null) m.withoutCost++;
          else if (origin) m.productLoss += value ?? 0;
        }
        return {
          reverseFreight: round2(m.reverseFreight),
          freightRefunded: round2(m.freightRefunded),
          freightInMediation: round2(m.freightInMediation),
          productLoss: round2(m.productLoss),
          recovered: round2(m.recovered),
          totalCost: round2(m.reverseFreight - m.freightRefunded + m.productLoss),
          withoutCost: m.withoutCost,
        };
      };

      const reasons = new Map<ReturnReason, number>();
      const products = new Map<string, { sku: string | null; name: string | null; itemId: string | null; qty: number; loss: number }>();
      const mediations = { ganha: 0, perdida: 0, parcial: 0, em_andamento: 0 };
      const classes: Record<ReturnClass, number> = { A: 0, B: 0, C: 0 };
      const statuses: Partial<Record<ReturnStatus, number>> = {};
      const series = new Map<string, { total: number; resolved: number; open: number; cost: number }>();
      for (let d = 0; d < days; d++) {
        series.set(new Date(Date.now() - (days - 1 - d) * 86_400_000).toISOString().slice(0, 10), { total: 0, resolved: 0, open: 0, cost: 0 });
      }
      for (const { r, dto } of current) {
        reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
        if (r.mediation_result) mediations[r.mediation_result]++;
        if (r.c_class) classes[r.c_class]++;
        statuses[dto.status] = (statuses[dto.status] ?? 0) + 1;
        const [, value] = await loss(r);
        const cost = (num(r.platform_cost) ?? 0) + (value ?? 0);
        const day = series.get(r.opened_at.toISOString().slice(0, 10));
        if (day) {
          day.total++;
          if (dto.status === 'resolvida' || dto.status === 'finalizada') day.resolved++;
          else day.open++;
          day.cost = round2(day.cost + cost);
        }
        for (const i of r.items ?? []) {
          const k = i.sku ?? i.itemId;
          if (!k) continue;
          const p = products.get(k) ?? { sku: i.sku, name: i.name, itemId: i.itemId, qty: 0, loss: 0 };
          p.qty += 1;
          p.loss = round2(p.loss + cost);
          p.name = p.name ?? i.name;
          products.set(k, p);
        }
      }
      const top = [...products.values()].sort((a, b) => b.qty - a.qty || b.loss - a.loss).slice(0, 8);
      const pics = await this.repo.pictures(db, top.map((p) => p.itemId).filter((x): x is string => Boolean(x)));
      const total = current.length || 1;
      return {
        days,
        from: from.toISOString(),
        to: new Date().toISOString(),
        total: current.length,
        totalPrevious: previous.length,
        money: await money(current),
        moneyPrevious: await money(previous),
        reasons: [...reasons.entries()].sort((a, b) => b[1] - a[1]).map(([reason, qty]) => ({ reason, qty, pct: Math.round((1000 * qty) / total) / 10 })),
        products: top.map((p) => ({ sku: p.sku, name: p.name, pictureUrl: (p.itemId && pics.get(p.itemId)) || null, qty: p.qty, loss: p.loss })),
        mediations,
        classes,
        statuses,
        series: [...series.entries()].map(([day, v]) => ({ day, ...v })),
      };
    });
  }

  // ================= detalhe / bipe
  async detail(tenantId: string, id: string): Promise<ReturnDetailDto> {
    return this.db.withTenant(tenantId, (db) => this.detailIn(db, id));
  }

  private async detailIn(db: Queryable, id: string): Promise<ReturnDetailDto> {
    const [r] = await this.repo.rows(db, 'r.id = $1', [id]);
    if (!r) throw new NotFoundError('Devolução não encontrada');
    const [row] = await this.withPictures(db, [toRow(r)]);
    return {
      row: row!,
      evidence: await this.repo.evidence(db, id),
      disputes: await this.repo.disputes(db, id),
      evidenceRequired: Boolean(row!.check && (row!.check.dispute || row!.check.manualTicket)),
    };
  }

  /**
   * O que o leitor chama: etiqueta, QR, DANFE, rastreio, pedido — o que vier. Não achou no índice? Pergunta ao ML de que
   * pedido é aquele nº de envio e aprende o código. `label`: código bipado que não foi achado e que o operador
   * identificou digitando a venda — fica vinculado para o próximo bipe.
   */
  async find(tenantId: string, code: string, label?: string): Promise<ReturnDetailDto[]> {
    const candidates = extractCodes(code);
    let ids = await this.db.withTenant(tenantId, (db) => this.repo.idsByCodes(db, candidates));
    if (!ids.length && this.api) {
      for (const c of candidates.filter((x) => /^\d{10,12}$/.test(x))) {
        const order = await this.orderOfShipment(tenantId, c).catch(() => null);
        if (!order) continue;
        ids = await this.db.withTenant(tenantId, (db) => this.repo.idsByCodes(db, [order]));
        if (ids.length) {
          await this.db.withTenant(tenantId, async (db) => {
            for (const id of ids) await this.repo.addCodes(db, tenantId, id, [c], 'bipe');
          });
          break;
        }
      }
    }
    if (label && ids.length) {
      await this.db.withTenant(tenantId, async (db) => {
        for (const id of ids) await this.repo.addCodes(db, tenantId, id, extractCodes(label), 'bipe');
      });
    }
    return this.db.withTenant(tenantId, async (db) => Promise.all(ids.map((id) => this.detailIn(db, id))));
  }

  private async orderOfShipment(tenantId: string, shipmentId: string): Promise<string | null> {
    for (const c of (await this.ml.status(tenantId)).connections.filter((x) => x.status === 'active')) {
      const { token } = await this.ml.accessToken(tenantId, c.id);
      const s = await this.api!.rawGet<{ order_id?: number | string }>(token, `/shipments/${encodeURIComponent(shipmentId)}`);
      if (s?.order_id) return String(s.order_id);
    }
    return null;
  }

  // ================= conferência
  async check(a: ReturnActor, id: string, input: ReturnCheckInput): Promise<ReturnDetailDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const [r] = await this.repo.rows(db, 'r.id = $1', [id]);
      if (!r) throw new NotFoundError('Devolução não encontrada');
      if (r.c_stock_done_at) throw new Locked('O estoque desta devolução já foi ajustado: a conferência não pode mais mudar.');
      if (r.disputed) throw new Locked('Esta devolução já foi contestada ou aceita no ML: a conferência não pode mais mudar.');
      const qty = (r.items ?? []).reduce((s, i) => s + (i.qty || 0), 0) || 1;
      const soldSku = (r.items ?? []).find((i) => i.sku)?.sku ?? null;
      const checkInput = { ...input, ourError: input.productCorrect ? false : input.ourError };
      const d = decide(
        { responsible: r.responsible, canDispute: r.can_dispute, platformCost: num(r.platform_cost) },
        checkInput,
        await this.repo.costAt(db, soldSku, new Date()),
        await this.repo.costAt(db, input.skuReceived ?? null, new Date()),
        qty,
      );
      await db.query(
        `INSERT INTO return_checks (return_id, tenant_id, sku_received, product_correct, complete, unused, resellable, our_error, note,
                                    class, stock_moves, dispute, decision, manual_ticket, product_loss, reverse_freight, checked_by, checked_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17, now())
         ON CONFLICT (return_id) DO UPDATE SET sku_received = EXCLUDED.sku_received, product_correct = EXCLUDED.product_correct,
           complete = EXCLUDED.complete, unused = EXCLUDED.unused, resellable = EXCLUDED.resellable, our_error = EXCLUDED.our_error,
           note = EXCLUDED.note, class = EXCLUDED.class, stock_moves = EXCLUDED.stock_moves, dispute = EXCLUDED.dispute,
           decision = EXCLUDED.decision, manual_ticket = EXCLUDED.manual_ticket, product_loss = EXCLUDED.product_loss,
           reverse_freight = EXCLUDED.reverse_freight, checked_by = EXCLUDED.checked_by, checked_at = now()`,
        [
          id, a.tenantId, input.skuReceived?.trim().toUpperCase() || null, checkInput.productCorrect, checkInput.complete, checkInput.unused,
          checkInput.resellable, checkInput.ourError, input.note?.trim() || null, d.class, JSON.stringify(d.stockMoves), d.dispute,
          d.decision, d.manualTicket, d.productLoss, d.reverseFreight, a.operatorId,
        ],
      );
      return this.detailIn(db, id);
    });
  }

  async stockDone(a: ReturnActor, id: string): Promise<ReturnDetailDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      const r = await db.query('UPDATE return_checks SET stock_done_at = now() WHERE return_id = $1 AND stock_done_at IS NULL', [id]);
      if (!r.rowCount) throw new NotFoundError('Confira a devolução antes (ou o estoque já foi marcado como ajustado).');
      return this.detailIn(db, id);
    });
  }

  async manualTicket(a: ReturnActor, id: string, opts: { open: boolean; protocol?: string; note?: string }): Promise<ReturnDetailDto> {
    return this.db.withTenant(a.tenantId, async (db) => {
      if (opts.open) {
        const r = await db.query(
          `UPDATE return_checks SET ticket_opened_at = now(), ticket_protocol = nullif($2, ''),
                  note = CASE WHEN $3 = '' THEN note ELSE trim(both E'\\n' from coalesce(note, '') || E'\\n[chamado] ' || $3) END
            WHERE return_id = $1 AND manual_ticket`,
          [id, opts.protocol ?? '', opts.note ?? ''],
        );
        if (!r.rowCount) throw new NotFoundError('Esta devolução não tem chamado manual pendente.');
        await db.query('DELETE FROM return_evidence WHERE return_id = $1', [id]); // as fotos já foram anexadas no painel do ML
      } else {
        const r = await db.query(
          `UPDATE return_checks SET manual_ticket = true, dispute = false,
                  decision = 'A contestação pela API não passou: fica na lista de chamados manuais com o prejuízo registrado.'
            WHERE return_id = $1`,
          [id],
        );
        if (!r.rowCount) throw new NotFoundError('Confira a devolução antes.');
      }
      return this.detailIn(db, id);
    });
  }

  // ================= evidências (fotos)
  async addEvidence(a: ReturnActor, id: string, mime: string, bytes: Buffer) {
    if (!PHOTO_TYPES.has(mime)) throw new ValidationError('Envie uma foto (JPG, PNG ou WebP). Vídeo não vai pela API do ML: anexe pelo painel.');
    if (bytes.length > PHOTO_MAX) throw new ValidationError('Foto maior que 8 MB.');
    const jpg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const png = bytes.subarray(0, 4).toString('hex') === '89504e47';
    const webp = bytes.subarray(0, 4).toString('latin1') === 'RIFF' && bytes.subarray(8, 12).toString('latin1') === 'WEBP';
    if (!(jpg || png || webp)) throw new ValidationError('O arquivo não é uma imagem válida.');
    return this.db.withTenant(a.tenantId, async (db) => {
      if (!(await db.query('SELECT 1 FROM returns WHERE id = $1', [id])).rowCount) throw new NotFoundError('Devolução não encontrada');
      await db.query(
        'INSERT INTO return_evidence (tenant_id, return_id, mime, bytes, size, added_by) VALUES ($1, $2, $3, $4, $5, $6)',
        [a.tenantId, id, jpg ? 'image/jpeg' : png ? 'image/png' : 'image/webp', bytes, bytes.length, a.operatorId],
      );
      // varredura barata: foto de devolução parada há mais de 30 dias não vai mais a disputa
      await db.query(`DELETE FROM return_evidence WHERE added_at < now() - interval '30 days'`);
      return this.repo.evidence(db, id);
    });
  }

  async evidenceFile(tenantId: string, evidenceId: string) {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ mime: string; bytes: Buffer }>('SELECT mime, bytes FROM return_evidence WHERE id = $1', [evidenceId]);
      if (!rows[0]) throw new NotFoundError('Foto não encontrada');
      return rows[0];
    });
  }

  async deleteEvidence(tenantId: string, evidenceId: string) {
    await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query('DELETE FROM return_evidence WHERE id = $1', [evidenceId]);
      if (!r.rowCount) throw new NotFoundError('Foto não encontrada');
    });
  }

  // ================= contestação / aceite no ML
  private async session(tenantId: string, id: string) {
    if (!this.api) throw new ValidationError('Integração com o Mercado Livre não configurada neste ambiente');
    const meta = await this.db.withTenant(tenantId, (db) => this.repo.raw(db, id));
    if (!meta) throw new NotFoundError('Devolução não encontrada');
    if (meta.external_id.startsWith('envio-')) throw new ValidationError('Pacote não entregue não tem reclamação no ML: não há o que contestar ou aceitar.');
    const conns = (await this.ml.status(tenantId)).connections.filter((c) => c.status === 'active');
    const conn = conns.find((c) => c.accountId === meta.account_id) ?? conns[0];
    if (!conn) throw new ValidationError('Conecte a conta do Mercado Livre para agir nas devoluções.');
    const { token } = await this.ml.accessToken(tenantId, conn.id);
    return { token, claimId: meta.external_id, api: this.api };
  }

  /** Motivos oficiais do ML para "reportar um problema" (o operador escolhe também quando vai à mediação). */
  async disputeReasons(tenantId: string, id: string): Promise<{ id: string; text: string }[]> {
    const { token, claimId, api } = await this.session(tenantId, id);
    const reasons = await api.rawGet<{ id: string; detail: string }[]>(token, `/post-purchase/v1/returns/reasons?flow=seller_return_failed&claim_id=${claimId}`);
    return (reasons ?? []).map((m) => ({ id: String(m.id), text: m.detail }));
  }

  async dispute(a: ReturnActor, id: string, input: { reason: string; reasonText?: string; message: string }): Promise<ReturnDetailDto> {
    const prep = await this.db.withTenant(a.tenantId, async (db) => {
      const [r] = await this.repo.rows(db, 'r.id = $1', [id]);
      if (!r) throw new NotFoundError('Devolução não encontrada');
      if (!r.c_class) throw new ValidationError('Confira o produto antes de contestar.');
      if (!r.c_dispute) throw new Locked(`A conferência concluiu que não vale contestar: ${r.c_decision}`);
      if (r.disputed) throw new Locked('Esta devolução já foi contestada ou aceita.');
      const photos = (await db.query<{ id: string; mime: string; bytes: Buffer }>('SELECT id, mime, bytes FROM return_evidence WHERE return_id = $1 ORDER BY added_at', [id])).rows;
      if (!photos.length) throw new ValidationError('Anexe ao menos uma foto do produto e da embalagem antes de contestar.');
      return { perfect: r.c_class === 'A', photos };
    });
    const { token, claimId, api } = await this.session(a.tenantId, id);
    const official = await this.disputeReasons(a.tenantId, id);
    if (official.length && !official.some((m) => m.id === input.reason)) throw new ValidationError('Escolha um dos motivos oficiais do ML.');
    const reasonText = official.find((m) => m.id === input.reason)?.text ?? input.reasonText ?? '';

    let result: { ok: boolean; path: string | null; attachments: string[]; error: string | null };
    try {
      const claim = await api.rawGet<Json>(token, `/post-purchase/v1/claims/${claimId}`);
      const actions = new Set(sellerActions(claim).map((x) => x.action));
      const reviewFail = ['return_review_fail', 'return_review_unified_fail'].some((x) => actions.has(x));
      const mediation = ['open_dispute', 'send_message_to_mediator'].some((x) => actions.has(x));
      const files = prep.photos.map((p, i) => ({ name: `evidencia-${i + 1}.${PHOTO_TYPES.get(p.mime) ?? 'jpg'}`, type: p.mime, bytes: p.bytes }));
      // produto com problema → revisão com falha ("Reportar um problema"); produto perfeito com a empresa cobrada → mediação
      if (reviewFail && (!prep.perfect || !mediation)) {
        const ret = await api.rawGet<Json>(token, `/post-purchase/v2/claims/${claimId}/returns`);
        const names: string[] = [];
        for (const f of files) names.push((await api.rawUpload<Json>(token, `/post-purchase/v1/claims/${claimId}/returns/attachments`, f)).file_name);
        await api.rawPost(token, `/post-purchase/v1/returns/${ret.id}/return-review`, [{ reason: input.reason, message: input.message, attachments: names }]);
        result = { ok: true, path: 'revisao_com_falha', attachments: names, error: null };
      } else if (mediation) {
        if (actions.has('open_dispute')) await api.rawPost(token, `/post-purchase/v1/claims/${claimId}/actions/open-dispute`, {});
        const names: string[] = [];
        for (const f of files) names.push((await api.rawUpload<Json>(token, `/post-purchase/v1/claims/${claimId}/attachments`, f)).filename);
        await api.rawPost(token, `/post-purchase/v1/claims/${claimId}/actions/send-message`, {
          receiver_role: 'mediator',
          message: reasonText ? `[${reasonText}] ${input.message}` : input.message,
          attachments: names,
        });
        result = { ok: true, path: 'mediacao', attachments: names, error: null };
      } else {
        throw new Error(`O ML não libera contestação nesta reclamação agora (ações: ${[...actions].sort().join(', ') || 'nenhuma'}).`);
      }
    } catch (err) {
      result = { ok: false, path: null, attachments: [], error: (err as Error).message.slice(0, 500) };
    }
    return this.db.withTenant(a.tenantId, async (db) => {
      await db.query(
        `INSERT INTO return_disputes (tenant_id, return_id, reason, message, ok, path, attachments, error, sent_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [a.tenantId, id, input.reason, input.message, result.ok, result.path, JSON.stringify(result.attachments), result.error, a.operatorId],
      );
      if (result.ok) await db.query('DELETE FROM return_evidence WHERE return_id = $1', [id]); // o ML já recebeu as fotos
      return this.detailIn(db, id);
    });
  }

  /** "Chegou como esperado": revisão OK (corpo vazio); o ML finaliza e reembolsa o comprador. */
  async accept(a: ReturnActor, id: string): Promise<ReturnDetailDto> {
    const already = await this.db.withTenant(a.tenantId, async (db) => (await this.repo.rows(db, 'r.id = $1', [id]))[0]);
    if (!already) throw new NotFoundError('Devolução não encontrada');
    if (already.disputed) throw new Locked('Esta devolução já foi contestada ou aceita.');
    const { token, claimId, api } = await this.session(a.tenantId, id);
    let ok = false;
    let error: string | null = null;
    try {
      const claim = await api.rawGet<Json>(token, `/post-purchase/v1/claims/${claimId}`);
      if (!sellerActions(claim).some((x) => REVIEW_OK.has(x.action))) throw new Error('O ML não libera o aceite desta reclamação agora: aceite pelo painel.');
      const ret = await api.rawGet<Json>(token, `/post-purchase/v2/claims/${claimId}/returns`);
      await api.rawPost(token, `/post-purchase/v1/returns/${ret.id}/return-review`, {});
      ok = true;
    } catch (err) {
      error = (err as Error).message.slice(0, 500);
    }
    return this.db.withTenant(a.tenantId, async (db) => {
      await db.query(
        `INSERT INTO return_disputes (tenant_id, return_id, reason, message, ok, path, error, sent_by)
         VALUES ($1, $2, 'aceite', 'Devolução aceita', $3, $4, $5, $6)`,
        [a.tenantId, id, ok, ok ? 'aceite' : null, error, a.operatorId],
      );
      if (ok) await db.query('DELETE FROM return_evidence WHERE return_id = $1', [id]);
      return this.detailIn(db, id);
    });
  }

  // ================= respostas prontas ("o que você viu")
  async replies(tenantId: string) {
    return this.db.withTenant(tenantId, async (db) =>
      (await db.query<{ id: string; text: string }>('SELECT id, text FROM return_replies ORDER BY created_at')).rows,
    );
  }

  async addReply(tenantId: string, text: string) {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ id: string; text: string }>('INSERT INTO return_replies (tenant_id, text) VALUES ($1, $2) RETURNING id, text', [tenantId, text]);
      return rows[0]!;
    });
  }

  async deleteReply(tenantId: string, replyId: string) {
    await this.db.withTenant(tenantId, async (db) => {
      if (!(await db.query('DELETE FROM return_replies WHERE id = $1', [replyId])).rowCount) throw new NotFoundError('Resposta não encontrada');
    });
  }
}

