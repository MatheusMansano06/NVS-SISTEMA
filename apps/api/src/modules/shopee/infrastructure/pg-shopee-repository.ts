import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { orderFinance, type ShopeeEscrowRow } from '../domain/shopee-escrow.js';

export interface ShopeeConnectionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  shop_id: string;
  nickname: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  auth_expires_at: Date | null;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
  sync_status: 'idle' | 'running' | 'failed';
  sync_error: string | null;
  orders_imported: number;
  backfilled: boolean;
  last_synced_at: Date | null;
  escrow_until: Date | null;
  updated_at: Date;
}

/** Escrow lido da Shopee, com a situação do repasse. */
export interface EscrowWrite extends ShopeeEscrowRow {
  settled: boolean;
  released_at: string | null;
  payout_amount: number | null;
}

const COLS = `c.id, c.tenant_id, c.account_id, c.shop_id, a.nickname, c.access_token_enc, c.refresh_token_enc, c.expires_at,
  c.auth_expires_at, c.status, c.last_error, c.sync_status, c.sync_error, c.orders_imported, c.backfilled, c.last_synced_at,
  c.escrow_until, c.updated_at`;
const FROM = 'FROM shopee_connections c JOIN marketplace_accounts a ON a.id = c.account_id';

export class PgShopeeRepository {
  constructor(private readonly db: Database) {}

  // ---------- globais (sem RLS)
  async hasFeature(tenantId: string): Promise<boolean> {
    const r = await this.db.query<{ ok: boolean }>(`SELECT 'shopee' = ANY(features) AS ok FROM tenants WHERE id = $1`, [tenantId]);
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

  /** Vincula a loja à empresa; retorna a empresa dona (uma loja pertence a uma só empresa). */
  async claimIdentity(shopId: string, tenantId: string): Promise<string> {
    await this.db.query(
      `INSERT INTO marketplace_identities (marketplace, external_user_id, tenant_id) VALUES ('shopee', $1, $2) ON CONFLICT DO NOTHING`,
      [shopId, tenantId],
    );
    const { rows } = await this.db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM marketplace_identities WHERE marketplace = 'shopee' AND external_user_id = $1",
      [shopId],
    );
    return rows[0]!.tenant_id;
  }

  /** Empresas ativas, com o recurso liberado e loja vinculada. */
  async connectedTenants(): Promise<string[]> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      `SELECT DISTINCT mi.tenant_id FROM marketplace_identities mi JOIN tenants t ON t.id = mi.tenant_id
        WHERE mi.marketplace = 'shopee' AND t.status = 'active' AND 'shopee' = ANY(t.features)`,
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
    p: { tenantId: string; shopId: string; nickname: string; access: string; refresh: string; expiresAt: Date; authExpiresAt: Date | null },
  ): Promise<string> {
    const acc = await db.query<{ id: string }>(
      `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'shopee', $2, $3)
       ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id`,
      [p.tenantId, p.nickname, p.shopId],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO shopee_connections (tenant_id, account_id, shop_id, access_token_enc, refresh_token_enc, expires_at, refresh_expires_at, auth_expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, now() + interval '30 days', $7)
       ON CONFLICT (account_id) DO UPDATE
         SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
             expires_at = EXCLUDED.expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at,
             auth_expires_at = coalesce(EXCLUDED.auth_expires_at, shopee_connections.auth_expires_at),
             status = 'active', last_error = NULL, updated_at = now()
       RETURNING id`,
      [p.tenantId, acc.rows[0]!.id, p.shopId, p.access, p.refresh, p.expiresAt, p.authExpiresAt],
    );
    return rows[0]!.id;
  }

  async connections(db: Queryable): Promise<ShopeeConnectionRow[]> {
    return (await db.query<ShopeeConnectionRow>(`SELECT ${COLS} ${FROM} ORDER BY c.created_at`)).rows;
  }

  /** `lock`: trava a linha (uma renovação de token por vez entre instâncias). */
  async findConnection(db: Queryable, id: string, lock = false): Promise<ShopeeConnectionRow | null> {
    return (await db.query<ShopeeConnectionRow>(`SELECT ${COLS} ${FROM} WHERE c.id = $1 ${lock ? 'FOR UPDATE OF c' : ''}`, [id])).rows[0] ?? null;
  }

  async updateTokens(db: Queryable, id: string, access: string, refresh: string, expiresAt: Date): Promise<void> {
    await db.query(
      `UPDATE shopee_connections SET access_token_enc = $2, refresh_token_enc = $3, expires_at = $4,
              refresh_expires_at = now() + interval '30 days', status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id, access, refresh, expiresAt],
    );
  }

  async setAuthExpiry(db: Queryable, id: string, at: Date | null): Promise<void> {
    if (at) await db.query('UPDATE shopee_connections SET auth_expires_at = $2 WHERE id = $1', [id, at]);
  }

  async markRevoked(db: Queryable, id: string, error: string): Promise<void> {
    await db.query(`UPDATE shopee_connections SET status = 'revoked', last_error = $2, updated_at = now() WHERE id = $1`, [id, error]);
  }

  /** Estado da sincronização; `updated_at` serve de sinal de vida (execução parada há 10 min = interrompida). */
  async setSync(
    db: Queryable,
    id: string,
    s: { status: 'idle' | 'running' | 'failed'; error?: string | null; imported?: number; reset?: boolean; backfilled?: boolean; synced?: boolean },
  ): Promise<void> {
    await db.query(
      `UPDATE shopee_connections SET sync_status = $2, sync_error = $3,
              orders_imported = CASE WHEN $5 THEN 0 ELSE orders_imported END + $4,
              backfilled = backfilled OR $6, last_synced_at = CASE WHEN $7 THEN now() ELSE last_synced_at END, updated_at = now()
        WHERE id = $1`,
      [id, s.status, s.error ?? null, s.imported ?? 0, s.reset ?? false, s.backfilled ?? false, s.synced ?? false],
    );
  }

  /** Pedidos que não são venda (cancelados antes do pagamento): saem do sistema se já tinham sido importados. */
  async deleteOrders(db: Queryable, accountId: string, orderSns: string[]): Promise<void> {
    if (!orderSns.length) return;
    await db.query(`DELETE FROM orders WHERE account_id = $1 AND marketplace = 'shopee' AND external_id = ANY($2)`, [accountId, orderSns]);
  }

  /** Cancelado não tem repasse a conferir: sai da fila de "estimado". */
  async closeCancelled(db: Queryable, accountId: string): Promise<void> {
    await db.query(
      `UPDATE orders SET logistic_bucket = 'outros', finance_enriched_at = now()
        WHERE account_id = $1 AND marketplace = 'shopee' AND status = 'cancelled' AND finance_enriched_at IS NULL`,
      [accountId],
    );
  }

  /** Vendas ainda sem repasse liberado (o escrow delas é estimativa e pode mudar). */
  async unsettledOrders(db: Queryable, accountId: string, since: Date): Promise<string[]> {
    const { rows } = await db.query<{ external_id: string }>(
      `SELECT external_id FROM orders
        WHERE account_id = $1 AND marketplace = 'shopee' AND status <> 'cancelled' AND finance_enriched_at IS NULL AND ordered_at >= $2
        ORDER BY ordered_at DESC`,
      [accountId, since],
    );
    return rows.map((r) => r.external_id);
  }

  async setEscrowUntil(db: Queryable, id: string, until: Date): Promise<void> {
    await db.query('UPDATE shopee_connections SET escrow_until = $2, updated_at = now() WHERE id = $1', [id, until]);
  }

  /** Grava os escrows lidos. Repasse liberado não volta a ser estimativa. */
  async upsertEscrows(db: Queryable, tenantId: string, accountId: string, rows: EscrowWrite[]): Promise<void> {
    if (!rows.length) return;
    await db.query(
      `INSERT INTO shopee_escrows (tenant_id, account_id, order_sn, settled, released_at, payout_amount, produto, cupom, tarifa,
              tarifa_refund, frete_comprador, frete_vendedor, escrow_amount, ajuste, returned, tarifas, quality_flags, income, updated_at)
       SELECT $1, $2, x.order_sn, x.settled, x.released_at, x.payout_amount, x.produto, x.cupom, x.tarifa, x.tarifa_refund,
              x.frete_comprador, x.frete_vendedor, x.escrow_amount, x.ajuste, x.returned, x.tarifas,
              ARRAY(SELECT jsonb_array_elements_text(x.quality_flags)), x.income, now()
         FROM jsonb_to_recordset($3::jsonb) AS x(order_sn text, settled boolean, released_at timestamptz, payout_amount numeric,
              produto numeric, cupom numeric, tarifa numeric, tarifa_refund numeric, frete_comprador numeric, frete_vendedor numeric,
              escrow_amount numeric, ajuste numeric, returned boolean, tarifas jsonb, quality_flags jsonb, income jsonb)
       ON CONFLICT (tenant_id, account_id, order_sn) DO UPDATE
         SET settled = shopee_escrows.settled OR EXCLUDED.settled,
             released_at = coalesce(EXCLUDED.released_at, shopee_escrows.released_at),
             payout_amount = coalesce(EXCLUDED.payout_amount, shopee_escrows.payout_amount),
             produto = EXCLUDED.produto, cupom = EXCLUDED.cupom, tarifa = EXCLUDED.tarifa, tarifa_refund = EXCLUDED.tarifa_refund,
             frete_comprador = EXCLUDED.frete_comprador, frete_vendedor = EXCLUDED.frete_vendedor,
             escrow_amount = EXCLUDED.escrow_amount, ajuste = EXCLUDED.ajuste, returned = EXCLUDED.returned,
             tarifas = EXCLUDED.tarifas, quality_flags = EXCLUDED.quality_flags, income = EXCLUDED.income, updated_at = now()`,
      [tenantId, accountId, JSON.stringify(rows)],
    );
  }

  /** Marca como liberados os repasses da lista (o escrow deles já foi relido). */
  async markReleased(db: Queryable, accountId: string, released: { orderSn: string; payout: number; releasedAt: Date }[]): Promise<void> {
    if (!released.length) return;
    await db.query(
      `UPDATE shopee_escrows e SET settled = true, released_at = x.released_at, payout_amount = x.payout
         FROM jsonb_to_recordset($2::jsonb) AS x(order_sn text, payout numeric, released_at timestamptz)
        WHERE e.account_id = $1 AND e.order_sn = x.order_sn`,
      [accountId, JSON.stringify(released.map((r) => ({ order_sn: r.orderSn, payout: r.payout, released_at: r.releasedAt.toISOString() })))],
    );
  }

  /**
   * Leva o escrow para os pedidos: produto, cupom, tarifa, fretes e devolução passam a ser os da Shopee (a margem fecha
   * no repasse). Repasse liberado fecha o pedido (`finance_enriched_at`); estimativa deixa aberto. Retorna os pedidos
   * alterados (para recalcular imposto e custo).
   */
  async applyEscrows(db: Queryable, accountId: string, orderSns: string[]): Promise<string[]> {
    if (!orderSns.length) return [];
    const { rows } = await db.query<{
      id: string; order_sn: string; settled: boolean; items_gross: string; produto: string; cupom: string; tarifa: string; tarifa_refund: string;
      frete_comprador: string; frete_vendedor: string; ajuste: string; returned: boolean; after: string | null; escrow_amount: string;
    }>(
      `SELECT o.id, e.order_sn, e.settled, e.produto, e.cupom, e.tarifa, e.tarifa_refund, e.frete_comprador, e.frete_vendedor,
              e.ajuste, e.returned, e.escrow_amount, e.income->>'escrow_amount_after_adjustment' AS after,
              (SELECT coalesce(sum(i.quantity * i.unit_price), 0) FROM order_items i WHERE i.order_id = o.id) AS items_gross
         FROM shopee_escrows e JOIN orders o ON o.account_id = e.account_id AND o.marketplace = 'shopee' AND o.external_id = e.order_sn
        WHERE e.account_id = $1 AND e.order_sn = ANY($2) AND o.status <> 'cancelled'`,
      [accountId, orderSns],
    );
    if (!rows.length) return [];
    const n = Number;
    const updates = rows.map((r) => {
      const f = orderFinance(
        {
          produto: n(r.produto), cupom: n(r.cupom), tarifa: n(r.tarifa), tarifa_refund: n(r.tarifa_refund), frete_comprador: n(r.frete_comprador),
          frete_vendedor: n(r.frete_vendedor), ajuste: n(r.ajuste), returned: r.returned, escrow_after_adjustment: n(r.after ?? r.escrow_amount),
        },
        n(r.items_gross),
      );
      return { id: r.id, settled: r.settled, ...f };
    });
    await db.query(
      `UPDATE orders o
          SET status = x.status, gross_amount = x.gross, coupon_seller = x.coupon, marketplace_fee = x.fee, shipping_cost = x.shipping,
              buyer_shipping = x."buyerShipping", refund_partial = x.refund, logistic_bucket = 'outros',
              finance_enriched_at = CASE WHEN x.settled THEN coalesce(o.finance_enriched_at, now()) ELSE NULL END
         FROM jsonb_to_recordset($2::jsonb) AS x(id uuid, settled boolean, status text, gross numeric, coupon numeric, fee numeric,
              shipping numeric, "buyerShipping" numeric, refund numeric)
        WHERE o.account_id = $1 AND o.id = x.id`,
      [accountId, JSON.stringify(updates)],
    );
    return rows.map((r) => r.id);
  }
}
