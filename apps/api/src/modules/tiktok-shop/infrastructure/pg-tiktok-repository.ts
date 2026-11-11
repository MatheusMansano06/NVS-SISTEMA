import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import type { TiktokProductRow } from '../domain/tiktok-product.js';

export interface TiktokConnectionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  shop_id: string;
  shop_cipher: string;
  nickname: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  sync_status: 'idle' | 'running' | 'failed';
  sync_error: string | null;
  orders_imported: number;
  backfilled: boolean;
  last_synced_at: Date | null;
  statements_until: Date | null;
  updated_at: Date;
}

/** Transação de extrato já normalizada (ver a migration 0059). */
export interface LedgerRow {
  transaction_id: string;
  statement_id: string;
  statement_time: string;
  type: string;
  order_external_id: string | null;
  revenue: number;
  fee: number;
  shipping: number;
  adjustment: number;
  settlement: number;
  refund: number;
  breakdown: Record<string, number>;
}

const COLS = `c.id, c.tenant_id, c.account_id, c.shop_id, c.shop_cipher, a.nickname, c.access_token_enc, c.refresh_token_enc,
  c.expires_at, c.status, c.last_error, c.sync_status, c.sync_error, c.orders_imported, c.backfilled, c.last_synced_at, c.statements_until, c.updated_at`;
const FROM = 'FROM tiktok_connections c JOIN marketplace_accounts a ON a.id = c.account_id';

export class PgTiktokRepository {
  constructor(private readonly db: Database) {}

  // ---------- globais (sem RLS)
  async hasFeature(tenantId: string): Promise<boolean> {
    const r = await this.db.query<{ ok: boolean }>(`SELECT 'tiktok_shop' = ANY(features) AS ok FROM tenants WHERE id = $1`, [tenantId]);
    return r.rows[0]?.ok ?? false;
  }

  async saveState(state: string, tenantId: string, userId: string): Promise<void> {
    await this.db.query("DELETE FROM oauth_states WHERE created_at < now() - interval '15 minutes'");
    await this.db.query("INSERT INTO oauth_states (state, tenant_id, user_id, code_verifier) VALUES ($1, $2, $3, '')", [state, tenantId, userId]);
  }

  /** Consome o state (uso único) se tiver menos de 10 minutos. */
  async consumeState(state: string): Promise<{ tenant_id: string } | null> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      `DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes' RETURNING tenant_id`,
      [state],
    );
    return rows[0] ?? null;
  }

  /** Vincula a loja à empresa; retorna a empresa dona (pode ser outra: uma loja pertence a uma só empresa). */
  async claimIdentity(shopId: string, tenantId: string): Promise<string> {
    await this.db.query(
      `INSERT INTO marketplace_identities (marketplace, external_user_id, tenant_id) VALUES ('tiktok_shop', $1, $2) ON CONFLICT DO NOTHING`,
      [shopId, tenantId],
    );
    const { rows } = await this.db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM marketplace_identities WHERE marketplace = 'tiktok_shop' AND external_user_id = $1",
      [shopId],
    );
    return rows[0]!.tenant_id;
  }

  /** Empresas ativas, com o recurso liberado e loja vinculada. */
  async connectedTenants(): Promise<string[]> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      `SELECT DISTINCT mi.tenant_id FROM marketplace_identities mi JOIN tenants t ON t.id = mi.tenant_id
        WHERE mi.marketplace = 'tiktok_shop' AND t.status = 'active' AND 'tiktok_shop' = ANY(t.features)`,
    );
    return rows.map((r) => r.tenant_id);
  }

  /** Reserva o horário para este job (apenas uma instância vence). */
  async claimSlot(job: string, slot: Date): Promise<boolean> {
    const { rowCount } = await this.db.query('INSERT INTO scheduler_ticks (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING', [job, slot]);
    return rowCount === 1;
  }

  // ---------- escopados ao tenant (RLS)
  async upsertConnection(
    db: Queryable,
    p: { tenantId: string; shopId: string; cipher: string; nickname: string; access: string; refresh: string; expiresAt: Date; refreshExpiresAt: Date | null },
  ): Promise<string> {
    const acc = await db.query<{ id: string }>(
      `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'tiktok_shop', $2, $3)
       ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id`,
      [p.tenantId, p.nickname, p.shopId],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO tiktok_connections (tenant_id, account_id, shop_id, shop_cipher, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (account_id) DO UPDATE
         SET shop_cipher = EXCLUDED.shop_cipher, access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
             expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
             status = 'active', last_error = NULL, updated_at = now()
       RETURNING id`,
      [p.tenantId, acc.rows[0]!.id, p.shopId, p.cipher, p.access, p.refresh, p.expiresAt, p.refreshExpiresAt],
    );
    return rows[0]!.id;
  }

  async connections(db: Queryable): Promise<TiktokConnectionRow[]> {
    return (await db.query<TiktokConnectionRow>(`SELECT ${COLS} ${FROM} ORDER BY c.created_at`)).rows;
  }

  /** `lock`: trava a linha (uma renovação de token por vez entre instâncias). */
  async findConnection(db: Queryable, id: string, lock = false): Promise<TiktokConnectionRow | null> {
    return (await db.query<TiktokConnectionRow>(`SELECT ${COLS} ${FROM} WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [id])).rows[0] ?? null;
  }

  async updateTokens(db: Queryable, id: string, access: string, refresh: string, expiresAt: Date, refreshExpiresAt: Date | null): Promise<void> {
    await db.query(
      `UPDATE tiktok_connections SET access_token_enc = $2, refresh_token_enc = $3, expires_at = $4, refresh_expires_at = $5,
              status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id, access, refresh, expiresAt, refreshExpiresAt],
    );
  }

  async markRevoked(db: Queryable, id: string, error: string): Promise<void> {
    await db.query(`UPDATE tiktok_connections SET status = 'revoked', last_error = $2, updated_at = now() WHERE id = $1`, [id, error]);
  }

  /** Estado da sincronização; `updated_at` serve de sinal de vida (execução parada há 10 min = interrompida). */
  async setSync(
    db: Queryable,
    id: string,
    s: { status: 'idle' | 'running' | 'failed'; error?: string | null; imported?: number; reset?: boolean; backfilled?: boolean; synced?: boolean },
  ): Promise<void> {
    await db.query(
      `UPDATE tiktok_connections SET sync_status = $2, sync_error = $3,
              orders_imported = CASE WHEN $5 THEN 0 ELSE orders_imported END + $4,
              backfilled = backfilled OR $6, last_synced_at = CASE WHEN $7 THEN now() ELSE last_synced_at END, updated_at = now()
        WHERE id = $1`,
      [id, s.status, s.error ?? null, s.imported ?? 0, s.reset ?? false, s.backfilled ?? false, s.synced ?? false],
    );
  }

  /** Pedidos que não são venda (cancelados antes do pagamento): saem do sistema se já tinham sido importados. */
  async deleteOrders(db: Queryable, accountId: string, externalIds: string[]): Promise<number> {
    if (!externalIds.length) return 0;
    const { rowCount } = await db.query(
      `DELETE FROM orders WHERE account_id = $1 AND marketplace = 'tiktok_shop' AND external_id = ANY($2)`,
      [accountId, externalIds],
    );
    return rowCount ?? 0;
  }

  /** Cancelado não tem repasse a conferir: sai da fila de "tarifa estimada". */
  async closeCancelled(db: Queryable, accountId: string): Promise<void> {
    await db.query(
      `UPDATE orders SET logistic_bucket = 'outros', finance_enriched_at = now()
        WHERE account_id = $1 AND marketplace = 'tiktok_shop' AND status = 'cancelled' AND finance_enriched_at IS NULL`,
      [accountId],
    );
  }

  async setStatementsUntil(db: Queryable, id: string, until: Date): Promise<void> {
    await db.query('UPDATE tiktok_connections SET statements_until = $2, updated_at = now() WHERE id = $1', [id, until]);
  }

  /** Grava as transações de um extrato. Reler o mesmo extrato só atualiza (a chave é o id da transação). */
  async upsertTransactions(db: Queryable, tenantId: string, accountId: string, rows: LedgerRow[]): Promise<void> {
    if (!rows.length) return;
    await db.query(
      `INSERT INTO tiktok_statement_transactions
         (tenant_id, account_id, transaction_id, statement_id, statement_time, type, order_external_id,
          revenue, fee, shipping, adjustment, settlement, refund, breakdown)
       SELECT $1, $2, x.transaction_id, x.statement_id, x.statement_time, x.type, x.order_external_id,
              x.revenue, x.fee, x.shipping, x.adjustment, x.settlement, x.refund, x.breakdown
         FROM jsonb_to_recordset($3::jsonb) AS x(transaction_id text, statement_id text, statement_time timestamptz, type text,
              order_external_id text, revenue numeric, fee numeric, shipping numeric, adjustment numeric, settlement numeric,
              refund numeric, breakdown jsonb)
       ON CONFLICT (tenant_id, account_id, transaction_id) DO UPDATE
         SET statement_id = EXCLUDED.statement_id, statement_time = EXCLUDED.statement_time, type = EXCLUDED.type,
             order_external_id = EXCLUDED.order_external_id, revenue = EXCLUDED.revenue, fee = EXCLUDED.fee,
             shipping = EXCLUDED.shipping, adjustment = EXCLUDED.adjustment, settlement = EXCLUDED.settlement,
             refund = EXCLUDED.refund, breakdown = EXCLUDED.breakdown`,
      [tenantId, accountId, JSON.stringify(rows)],
    );
  }

  /**
   * Leva o extrato para os pedidos: tarifa, frete e devolução passam a ser a soma das transações do pedido.
   * Reembolso do TikTok ligado ao pedido (crédito) abate primeiro a devolução e depois as tarifas; cobrança extra
   * (ajuste negativo) entra como tarifa. Vale para os pedidos de `externalIds` e para os que ainda estavam só com
   * estimativa. Retorna os pedidos alterados (para recalcular imposto e custo).
   */
  async applyLedger(db: Queryable, accountId: string, externalIds: string[]): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `UPDATE orders o
          SET marketplace_fee = greatest(x.fee + x.charge - greatest(x.credit - x.refund, 0), 0),
              shipping_cost = greatest(x.shipping, 0),
              refund_partial = greatest(x.refund - x.credit, 0),
              logistic_bucket = 'outros', finance_enriched_at = now()
         FROM (SELECT order_external_id, sum(fee) AS fee, sum(shipping) AS shipping, sum(refund) AS refund,
                      sum(greatest(adjustment, 0)) AS credit, sum(greatest(-adjustment, 0)) AS charge
                 FROM tiktok_statement_transactions
                WHERE account_id = $1 AND order_external_id IS NOT NULL
                GROUP BY order_external_id) x
        WHERE o.account_id = $1 AND o.marketplace = 'tiktok_shop' AND o.external_id = x.order_external_id
          AND (o.finance_enriched_at IS NULL OR o.external_id = ANY($2))
        RETURNING o.id`,
      [accountId, externalIds],
    );
    return rows.map((r) => r.id);
  }

  /** Grava uma página do catálogo da loja (reler só atualiza). */
  async upsertProducts(db: Queryable, tenantId: string, accountId: string, rows: TiktokProductRow[]): Promise<void> {
    if (!rows.length) return;
    await db.query(
      `INSERT INTO tiktok_products (tenant_id, account_id, product_id, title, status, price, available_quantity, updated_at)
       SELECT $1, $2, x.product_id, x.title, x.status, x.price, x.available_quantity, now()
         FROM jsonb_to_recordset($3::jsonb) AS x(product_id text, title text, status text, price numeric, available_quantity integer)
       ON CONFLICT (tenant_id, account_id, product_id) DO UPDATE
         SET title = EXCLUDED.title, status = EXCLUDED.status, price = EXCLUDED.price,
             available_quantity = EXCLUDED.available_quantity, updated_at = now()`,
      [tenantId, accountId, JSON.stringify(rows)],
    );
  }

  /** Depois de ler o catálogo inteiro: o que não veio mais (excluído no TikTok) sai. */
  async pruneProducts(db: Queryable, accountId: string, before: Date): Promise<void> {
    await db.query('DELETE FROM tiktok_products WHERE account_id = $1 AND updated_at < $2', [accountId, before]);
  }

  /** Pedidos ainda sem repasse: tarifa e frete estimados pelo próprio TikTok (continuam marcados como estimativa). */
  async applyEstimates(db: Queryable, accountId: string, rows: { order: string; fee: number; shipping: number }[]): Promise<string[]> {
    if (!rows.length) return [];
    const { rows: out } = await db.query<{ id: string }>(
      `UPDATE orders o SET marketplace_fee = greatest(x.fee, 0), shipping_cost = greatest(x.shipping, 0)
         FROM jsonb_to_recordset($2::jsonb) AS x("order" text, fee numeric, shipping numeric)
        WHERE o.account_id = $1 AND o.marketplace = 'tiktok_shop' AND o.external_id = x."order"
          AND o.status = 'paid' AND o.finance_enriched_at IS NULL
          AND (o.marketplace_fee, o.shipping_cost) IS DISTINCT FROM (greatest(x.fee, 0), greatest(x.shipping, 0))
        RETURNING o.id`,
      [accountId, JSON.stringify(rows)],
    );
    return out.map((r) => r.id);
  }
}
