import type { Database, Queryable } from '../../../shared/infrastructure/database.js';

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
  updated_at: Date;
}

const COLS = `c.id, c.tenant_id, c.account_id, c.shop_id, c.shop_cipher, a.nickname, c.access_token_enc, c.refresh_token_enc,
  c.expires_at, c.status, c.last_error, c.sync_status, c.sync_error, c.orders_imported, c.backfilled, c.last_synced_at, c.updated_at`;
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

  /** Vendas ainda sem o extrato conferido (tarifa estimada), das mais recentes para as antigas. */
  async pendingSettlement(db: Queryable, accountId: string, since: Date, until: Date, limit: number): Promise<{ id: string; external_id: string }[]> {
    const { rows } = await db.query<{ id: string; external_id: string }>(
      `SELECT id, external_id FROM orders
        WHERE account_id = $1 AND marketplace = 'tiktok_shop' AND status = 'paid' AND finance_enriched_at IS NULL
          AND ordered_at >= $2 AND ordered_at < $3
        ORDER BY ordered_at DESC LIMIT $4`,
      [accountId, since, until, limit],
    );
    return rows;
  }

  /** Cancelado não tem repasse a conferir: sai da fila de "tarifa estimada". */
  async closeCancelled(db: Queryable, accountId: string): Promise<void> {
    await db.query(
      `UPDATE orders SET logistic_bucket = 'outros', finance_enriched_at = now()
        WHERE account_id = $1 AND marketplace = 'tiktok_shop' AND status = 'cancelled' AND finance_enriched_at IS NULL`,
      [accountId],
    );
  }

  async setSettlement(db: Queryable, orderId: string, fee: number, shipping: number): Promise<void> {
    await db.query(
      `UPDATE orders SET marketplace_fee = $2, shipping_cost = $3, logistic_bucket = 'outros', finance_enriched_at = now() WHERE id = $1`,
      [orderId, fee, shipping],
    );
  }
}
