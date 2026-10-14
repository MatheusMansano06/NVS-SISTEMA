import type { Database } from '../../../shared/infrastructure/database.js';
import { CHARGES, REFUNDS, cycle, keyOfDay, lastKeys, utcDay } from '../domain/invoice.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;
export type MlGet = <T>(path: string) => Promise<T | null>;
export interface TaskOutcome { consultadas: number; faltam: number; erro?: string }

/** O que conta como "a empresa atuou na mediação": levar ao mediador, mandar prova a ele ou contestar a revisão. */
export const ACTED = new Set(['open_dispute', 'send_message_to_mediator', 'return_review_fail']);
/** logistic_type do envio de ida que é venda Full. */
export const FULL = new Set(['fulfillment']);
const WHO: Record<string, string> = { respondent: 'vendedor', complainant: 'comprador', mediator: 'plataforma' };
const PARALLEL = 4;
const PER_ROUND = 300;
const REREAD_OPEN_MEDIATION_MS = 6 * 3_600_000;
const REREAD_OPEN_INVOICE_MS = 3 * 3_600_000;

/**
 * O ML nega alguns itens: 403 (o rawGet já devolve null) ou 401 "invalid_caller_id" (envio de outro vendedor). É daquele
 * item, não da conexão: marca e segue. Qualquer outro erro é da conexão e para a tarefa (fica para a próxima rodada).
 */
const noAccess = (err: unknown) => /invalid_caller_id|HTTP 403/.test(`${(err as Error)?.message} ${(err as { code?: string })?.code ?? ''}`);

async function inParallel<T, R>(items: T[], fn: (t: T) => Promise<R>, onProgress: (f: number) => void): Promise<[T, R | Error][]> {
  const out: [T, R | Error][] = new Array(items.length);
  let next = 0;
  let done = 0;
  await Promise.all(
    Array.from({ length: Math.min(PARALLEL, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        try {
          out[i] = [items[i]!, await fn(items[i]!)];
        } catch (err) {
          out[i] = [items[i]!, err as Error];
        }
        onProgress(++done / items.length);
      }
    }),
  );
  return out;
}

const connectionError = (results: [unknown, unknown][]) => {
  const e = results.find(([, r]) => r instanceof Error && !noAccess(r))?.[1] as Error | undefined;
  return e ? e.message.slice(0, 200) : undefined;
};

/**
 * Dados que o B.I precisa e que só a plataforma sabe, consultados uma vez por devolução em segundo plano (portado de
 * central/bi/logistica.py, mediacao_origem.py e fatura_ml.py). A sincronização das reclamações nunca apaga estas colunas.
 */
export class ReturnsEnrichment {
  private readonly invoiceReadAt = new Map<string, number>();

  constructor(private readonly db: Database) {}

  /** Venda Full x orgânica: o tipo de envio da venda não muda, então consulta uma vez por pedido. */
  async logistics(tenantId: string, accountId: string, get: MlGet, onProgress: (f: number) => void): Promise<TaskOutcome> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ order_id: string }>(
        `SELECT DISTINCT order_id FROM returns WHERE sale_logistic IS NULL AND account_id IS NOT DISTINCT FROM $1 LIMIT ${PER_ROUND + 1}`,
        [accountId],
      ),
    );
    const orders = rows.slice(0, PER_ROUND).map((r) => r.order_id);
    const results = await inParallel(orders, async (orderId) => {
      const order = await get<Json>(`/orders/${orderId}`);
      const ship = order?.shipping?.id ? await get<Json>(`/shipments/${order.shipping.id}`) : null;
      return String(ship?.logistic_type ?? ship?.logistic?.type ?? 'desconhecido').slice(0, 40);
    }, onProgress);
    const done = results.flatMap(([o, r]) => (r instanceof Error ? (noAccess(r) ? [[o, 'desconhecido']] : []) : [[o, r]]));
    await this.db.withTenant(tenantId, async (db) => {
      for (const [orderId, type] of done) await db.query('UPDATE returns SET sale_logistic = $2 WHERE order_id = $1', [orderId, type]);
    });
    return this.outcome(done.length, rows.length - done.length, results);
  }

  /** Quem levou à mediação: a primeira entrada na etapa "dispute" do histórico de status da reclamação. */
  async mediationOrigin(tenantId: string, accountId: string, get: MlGet, onProgress: (f: number) => void): Promise<TaskOutcome> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ id: string; external_id: string }>(
        `SELECT id, external_id FROM returns
          WHERE in_mediation AND mediation_opened_by IS NULL AND external_id NOT LIKE 'envio-%' AND account_id IS NOT DISTINCT FROM $1
          LIMIT ${PER_ROUND + 1}`,
        [accountId],
      ),
    );
    const todo = rows.slice(0, PER_ROUND);
    const results = await inParallel(todo, async (r) => {
      const history = (await get<Json[]>(`/post-purchase/v1/claims/${r.external_id}/status-history`)) ?? [];
      const dispute = history.filter((h) => h?.stage === 'dispute').sort((a, b) => String(a.date).localeCompare(String(b.date)));
      return dispute.length ? (WHO[dispute[0].change_by] ?? 'desconhecido') : 'desconhecido';
    }, onProgress);
    const done = results.flatMap(([r, who]) => (who instanceof Error ? (noAccess(who) ? [[r.id, 'desconhecido']] : []) : [[r.id, who]]));
    await this.db.withTenant(tenantId, async (db) => {
      for (const [id, who] of done) await db.query('UPDATE returns SET mediation_opened_by = $2 WHERE id = $1', [id, who]);
    });
    return this.outcome(done.length, rows.length - done.length, results);
  }

  /** Ações da empresa no histórico da reclamação: as nunca lidas e as abertas lidas há mais de 6 h. */
  async mediationActions(tenantId: string, accountId: string, get: MlGet, onProgress: (f: number) => void): Promise<TaskOutcome> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ id: string; external_id: string; closed: boolean }>(
        `SELECT id, external_id, coalesce(mediation_result, '') <> 'em_andamento' AS closed FROM returns
          WHERE in_mediation AND external_id NOT LIKE 'envio-%' AND account_id IS NOT DISTINCT FROM $1
            AND (mediation_actions_at IS NULL OR (NOT mediation_actions_closed AND mediation_actions_at < $2))
          LIMIT ${PER_ROUND + 1}`,
        [accountId, new Date(Date.now() - REREAD_OPEN_MEDIATION_MS)],
      ),
    );
    const todo = rows.slice(0, PER_ROUND);
    const results = await inParallel(todo, (r) => get<Json[]>(`/post-purchase/v1/claims/${r.external_id}/actions-history`), onProgress);
    let done = 0;
    await this.db.withTenant(tenantId, async (db) => {
      for (const [r, history] of results) {
        if (history instanceof Error && !noAccess(history)) continue; // conexão: fica para a próxima rodada
        const denied = history instanceof Error || history === null;
        const actions = [...new Set((denied ? [] : history).filter((h) => h?.player_role === 'respondent').map((h) => String(h.action_name)))].sort();
        await db.query(
          'UPDATE returns SET mediation_actions = $2, mediation_actions_closed = $3, mediation_actions_at = now() WHERE id = $1',
          [r.id, actions.join(',').slice(0, 200), r.closed || denied],
        );
        done++;
      }
    });
    return this.outcome(done, rows.length - done, results);
  }

  /**
   * Foto (e SKU) dos anúncios das devoluções que não estão no catálogo sincronizado — anúncio finalizado ou antigo.
   * O multiget do ML aceita até 20 itens por chamada; o que não tem foto fica gravado vazio para não buscar de novo.
   */
  async pictures(tenantId: string, get: MlGet, onProgress: (f: number) => void): Promise<TaskOutcome> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<{ item_id: string }>(
        `SELECT DISTINCT i->>'itemId' AS item_id FROM returns r, jsonb_array_elements(r.items) i
          WHERE i->>'itemId' IS NOT NULL
            AND NOT EXISTS (SELECT 1 FROM listings l WHERE l.external_id = i->>'itemId' AND l.picture_url IS NOT NULL)
            AND NOT EXISTS (SELECT 1 FROM ml_item_pictures p WHERE p.item_id = i->>'itemId')
          LIMIT ${PER_ROUND + 1}`,
      ),
    );
    const ids = rows.slice(0, PER_ROUND).map((r) => r.item_id);
    const lots = Array.from({ length: Math.ceil(ids.length / 20) }, (_, i) => ids.slice(i * 20, i * 20 + 20));
    const results = await inParallel(lots, (lot) => get<Json[]>(`/items?ids=${lot.join(',')}&attributes=id,secure_thumbnail,thumbnail,seller_custom_field,attributes,variations`), onProgress);
    let done = 0;
    await this.db.withTenant(tenantId, async (db) => {
      for (const [lot, res] of results) {
        if (res instanceof Error) continue; // conexão: tenta na próxima rodada
        const found = new Map<string, Json>((res ?? []).filter((x) => x?.code === 200 && x.body?.id).map((x) => [String(x.body.id), x.body]));
        for (const id of lot) {
          const b = found.get(id);
          const url = (b?.secure_thumbnail ?? b?.thumbnail ?? null)?.replace('-I.jpg', '-O.jpg') ?? null;
          const sku = b && !(b.variations ?? []).length
            ? (b.seller_custom_field ?? (b.attributes ?? []).find((a: Json) => a.id === 'SELLER_SKU')?.value_name ?? null)
            : null;
          await db.query(
            `INSERT INTO ml_item_pictures (tenant_id, item_id, url, sku) VALUES ($1, $2, $3, $4)
             ON CONFLICT (tenant_id, item_id) DO UPDATE SET url = EXCLUDED.url, sku = EXCLUDED.sku, fetched_at = now()`,
            [tenantId, id, url, sku],
          );
          done++;
        }
      }
    });
    return this.outcome(done, rows.length - done, results);
  }

  /** Tarifas de devolução da fatura do ML: fechada é lida uma vez; a aberta, de 3 em 3 h. */
  async billing(tenantId: string, get: MlGet, onProgress: (f: number) => void, opts: { months?: number; only?: string } = {}): Promise<Record<string, unknown>> {
    const today = utcDay(new Date());
    const keys = opts.only ? [opts.only] : lastKeys(today, opts.months ?? 3);
    const { rows } = await this.db.withTenant(tenantId, (db) => db.query<{ invoice: string }>('SELECT DISTINCT invoice FROM ml_billing_returns'));
    const have = new Set(rows.map((r) => r.invoice));
    const out: Record<string, unknown> = {};
    for (const [i, key] of keys.entries()) {
      const open = cycle(key)[1] >= today;
      const memo = `${tenantId}:${key}`;
      if (!opts.only && ((have.has(key) && !open) || Date.now() - (this.invoiceReadAt.get(memo) ?? 0) < REREAD_OPEN_INVOICE_MS)) continue;
      try {
        const lines = await this.downloadInvoice(get, key);
        await this.db.withTenant(tenantId, async (db) => {
          if (opts.only) await db.query('DELETE FROM ml_billing_returns WHERE invoice = $1', [key]);
          for (const l of lines) {
            await db.query(
              `INSERT INTO ml_billing_returns (tenant_id, detail_id, invoice, kind, order_id, amount, day) VALUES ($1,$2,$3,$4,$5,$6,$7)
               ON CONFLICT (tenant_id, detail_id) DO UPDATE SET invoice = EXCLUDED.invoice, kind = EXCLUDED.kind,
                 order_id = EXCLUDED.order_id, amount = EXCLUDED.amount, day = EXCLUDED.day`,
              [tenantId, l.detailId, l.invoice, l.kind, l.orderId, l.amount, l.day],
            );
          }
        });
        this.invoiceReadAt.set(memo, Date.now());
        out[key] = lines.length;
      } catch (err) {
        out[key] = `erro: ${(err as Error).message}`.slice(0, 120); // 429 da API de faturamento: este mês fica para a próxima
      }
      onProgress((i + 1) / keys.length);
    }
    return out;
  }

  private async downloadInvoice(get: MlGet, key: string) {
    const types = [...Object.keys(CHARGES), ...REFUNDS].join(',');
    const lines: { detailId: string; invoice: string; kind: string; orderId: string | null; amount: number; day: string | null }[] = [];
    for (let offset = 0; ; ) {
      const page = await get<{ results?: Json[]; total?: number }>(
        `/billing/integration/periods/key/${key}/group/ML/details?document_type=BILL&detail_sub_types=${types}&limit=150&offset=${offset}`,
      );
      const res = page?.results ?? [];
      for (const x of res) {
        const ci = x.charge_info ?? {};
        const day = String(ci.creation_date_time ?? '').slice(0, 10) || null;
        // a API repete lançamentos em faturas vizinhas (o período dela começa um mês antes): vale a data
        lines.push({
          detailId: String(ci.detail_id),
          invoice: day ? keyOfDay(day) : key,
          kind: String(ci.detail_sub_type),
          orderId: x.sales_info?.[0]?.order_id ? String(x.sales_info[0].order_id) : null,
          amount: Math.round((ci.detail_type === 'CHARGE' ? 1 : -1) * Number(ci.detail_amount ?? 0) * 100) / 100,
          day,
        });
      }
      offset += res.length;
      if (!res.length || offset >= (page?.total ?? 0)) return lines;
      await new Promise((r) => setTimeout(r, 1500)); // a API de faturamento corta rajadas com 429
    }
  }

  private outcome(done: number, left: number, results: [unknown, unknown][]): TaskOutcome {
    const erro = connectionError(results);
    return { consultadas: done, faltam: Math.max(0, left), ...(erro ? { erro } : {}) };
  }
}
