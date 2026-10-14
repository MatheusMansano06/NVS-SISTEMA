import type { SyncPhase } from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';

export interface ConnectionRow {
  id: string;
  tenant_id: string;
  account_id: string;
  ml_user_id: string;
  nickname: string;
  access_token_enc: string;
  refresh_token_enc: string;
  expires_at: Date;
  status: 'active' | 'revoked' | 'error';
  last_error: string | null;
}

export interface SyncRunRow {
  id: string;
  connection_id: string;
  status: 'running' | 'done' | 'failed';
  phase: SyncPhase;
  progress: number;
  orders_imported: number;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

const CONN_COLS = `c.id, c.tenant_id, c.account_id, c.ml_user_id::text, a.nickname, c.access_token_enc,
  c.refresh_token_enc, c.expires_at, c.status, c.last_error`;

export class PgMlRepository {
  constructor(private readonly db: Database) {}

  // ---------- globais (sem RLS)
  async saveState(state: string, tenantId: string, userId: string, verifier: string): Promise<void> {
    await this.db.query("DELETE FROM oauth_states WHERE created_at < now() - interval '15 minutes'");
    await this.db.query(
      'INSERT INTO oauth_states (state, tenant_id, user_id, code_verifier) VALUES ($1, $2, $3, $4)',
      [state, tenantId, userId, verifier],
    );
  }

  /** Consome o state (uso único) se tiver menos de 10 minutos. */
  async consumeState(state: string) {
    const { rows } = await this.db.query<{ tenant_id: string; user_id: string; code_verifier: string }>(
      `DELETE FROM oauth_states WHERE state = $1 AND created_at > now() - interval '10 minutes'
       RETURNING tenant_id, user_id, code_verifier`,
      [state],
    );
    return rows[0] ?? null;
  }

  /** Vincula a conta do ML à empresa; retorna a empresa dona (pode ser outra). */
  async claimIdentity(mlUserId: string, tenantId: string): Promise<string> {
    await this.db.query(
      `INSERT INTO marketplace_identities (marketplace, external_user_id, tenant_id)
       VALUES ('mercado_livre', $1, $2) ON CONFLICT DO NOTHING`,
      [mlUserId, tenantId],
    );
    const { rows } = await this.db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM marketplace_identities WHERE marketplace = 'mercado_livre' AND external_user_id = $1",
      [mlUserId],
    );
    return rows[0]!.tenant_id;
  }

  async tenantOf(mlUserId: string): Promise<string | null> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      "SELECT tenant_id FROM marketplace_identities WHERE marketplace = 'mercado_livre' AND external_user_id = $1",
      [mlUserId],
    );
    return rows[0]?.tenant_id ?? null;
  }

  // ---------- escopados ao tenant (RLS)
  async upsertConnection(
    db: Queryable,
    p: { tenantId: string; mlUserId: string; nickname: string; access: string; refresh: string; expiresAt: Date },
  ): Promise<string> {
    const acc = await db.query<{ id: string }>(
      `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id)
       VALUES ($1, 'mercado_livre', $2, $3)
       ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE SET nickname = EXCLUDED.nickname
       RETURNING id`,
      [p.tenantId, p.nickname, p.mlUserId],
    );
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO ml_connections (tenant_id, account_id, ml_user_id, access_token_enc, refresh_token_enc, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (account_id) DO UPDATE
         SET access_token_enc = EXCLUDED.access_token_enc, refresh_token_enc = EXCLUDED.refresh_token_enc,
             expires_at = EXCLUDED.expires_at, status = 'active', last_error = NULL, updated_at = now()
       RETURNING id`,
      [p.tenantId, acc.rows[0]!.id, p.mlUserId, p.access, p.refresh, p.expiresAt],
    );
    return rows[0]!.id;
  }

  async connections(db: Queryable): Promise<ConnectionRow[]> {
    const { rows } = await db.query<ConnectionRow>(
      `SELECT ${CONN_COLS} FROM ml_connections c JOIN marketplace_accounts a ON a.id = c.account_id ORDER BY c.created_at`,
    );
    return rows;
  }

  async connectionByMlUser(db: Queryable, mlUserId: string): Promise<ConnectionRow | null> {
    const { rows } = await db.query<ConnectionRow>(
      `SELECT ${CONN_COLS} FROM ml_connections c JOIN marketplace_accounts a ON a.id = c.account_id WHERE c.ml_user_id = $1`,
      [mlUserId],
    );
    return rows[0] ?? null;
  }

  /** Lê a conexão travando a linha (evita duas renovações simultâneas do refresh token de uso único). */
  async findConnection(db: Queryable, id: string): Promise<ConnectionRow | null> {
    const { rows } = await db.query<ConnectionRow>(
      `SELECT ${CONN_COLS} FROM ml_connections c JOIN marketplace_accounts a ON a.id = c.account_id WHERE c.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Serializa sincronizações da mesma conexão (entre requisições e instâncias) até o fim da transação. */
  async lockSync(db: Queryable, connectionId: string): Promise<void> {
    await db.query("SELECT pg_advisory_xact_lock(hashtext('ml-sync:' || $1))", [connectionId]);
  }

  async lockConnection(db: Queryable, id: string): Promise<ConnectionRow | null> {
    const { rows } = await db.query<ConnectionRow>(
      `SELECT ${CONN_COLS} FROM ml_connections c JOIN marketplace_accounts a ON a.id = c.account_id
        WHERE c.id = $1 FOR UPDATE OF c`,
      [id],
    );
    return rows[0] ?? null;
  }

  async updateTokens(db: Queryable, id: string, access: string, refresh: string, expiresAt: Date): Promise<void> {
    await db.query(
      `UPDATE ml_connections SET access_token_enc = $2, refresh_token_enc = $3, expires_at = $4,
              status = 'active', last_error = NULL, updated_at = now() WHERE id = $1`,
      [id, access, refresh, expiresAt],
    );
  }

  async markConnection(db: Queryable, id: string, status: ConnectionRow['status'], error: string | null): Promise<void> {
    await db.query('UPDATE ml_connections SET status = $2, last_error = $3, updated_at = now() WHERE id = $1', [id, status, error]);
  }

  async updateNickname(db: Queryable, accountId: string, nickname: string): Promise<void> {
    await db.query('UPDATE marketplace_accounts SET nickname = $2 WHERE id = $1', [accountId, nickname]);
  }

  async startRun(db: Queryable, tenantId: string, connectionId: string, kind: 'full' | 'incremental' = 'full'): Promise<string> {
    const { rows } = await db.query<{ id: string }>(
      'INSERT INTO ml_sync_runs (tenant_id, connection_id, kind) VALUES ($1, $2, $3) RETURNING id',
      [tenantId, connectionId, kind],
    );
    return rows[0]!.id;
  }

  async updateRun(
    db: Queryable,
    id: string,
    p: Partial<{ status: SyncRunRow['status']; phase: SyncPhase; progress: number; addOrders: number; error: string }>,
  ): Promise<void> {
    await db.query(
      `UPDATE ml_sync_runs SET
         status = COALESCE($2, status), phase = COALESCE($3, phase), progress = COALESCE($4, progress),
         orders_imported = orders_imported + COALESCE($5, 0), error = COALESCE($6, error), updated_at = now(),
         finished_at = CASE WHEN COALESCE($2, status) IN ('done', 'failed') THEN now() ELSE finished_at END
       WHERE id = $1`,
      [id, p.status ?? null, p.phase ?? null, p.progress ?? null, p.addOrders ?? null, p.error ?? null],
    );
  }

  /** Execução mais recente; uma "running" parada há mais de 3 min é considerada interrompida. */
  async latestRun(db: Queryable, connectionId: string, kind: 'full' | 'incremental' = 'full'): Promise<SyncRunRow | null> {
    const { rows } = await db.query<SyncRunRow>(
      `SELECT id, connection_id,
              CASE WHEN status = 'running' AND updated_at < now() - interval '3 minutes' THEN 'failed' ELSE status END AS status,
              phase, progress, orders_imported,
              CASE WHEN status = 'running' AND updated_at < now() - interval '3 minutes'
                   THEN 'Sincronização interrompida. Tente novamente.' ELSE error END AS error,
              started_at, finished_at
         FROM ml_sync_runs WHERE connection_id = $1 AND kind = $2 ORDER BY started_at DESC LIMIT 1`,
      [connectionId, kind],
    );
    return rows[0] ?? null;
  }

  async lastSyncedAt(db: Queryable, connectionId: string): Promise<Date | null> {
    const { rows } = await db.query<{ at: Date | null }>(
      "SELECT max(finished_at) AS at FROM ml_sync_runs WHERE connection_id = $1 AND status = 'done'",
      [connectionId],
    );
    return rows[0]?.at ?? null;
  }

  /** Reserva o horário para este job (apenas uma instância vence). */
  async claimSlot(job: string, slot: Date): Promise<boolean> {
    const { rowCount } = await this.db.query(
      'INSERT INTO scheduler_ticks (job, slot) VALUES ($1, $2) ON CONFLICT DO NOTHING',
      [job, slot],
    );
    return rowCount === 1;
  }

  /** Empresas com conta do ML vinculada (tabela global de roteamento). */
  async connectedTenants(): Promise<string[]> {
    const { rows } = await this.db.query<{ tenant_id: string }>(
      // empresa suspensa pela master não gasta ML nem banco nos agendadores
      `SELECT DISTINCT mi.tenant_id FROM marketplace_identities mi JOIN tenants t ON t.id = mi.tenant_id
        WHERE mi.marketplace = 'mercado_livre' AND t.status = 'active'`,
    );
    return rows.map((r) => r.tenant_id);
  }

  // ---------- faturamento (fatura mensal do ML)
  async billingFetched(db: Queryable, accountId: string): Promise<Map<string, { status: string | null; fetchedAt: Date }>> {
    const { rows } = await db.query<{ key: string; status: string | null; fetched_at: Date }>(
      `SELECT to_char(period_key, 'YYYY-MM-DD') AS key, status, fetched_at FROM ml_billing_periods WHERE account_id = $1`,
      [accountId],
    );
    return new Map(rows.map((r) => [r.key, { status: r.status, fetchedAt: r.fetched_at }]));
  }

  async saveBilling(
    db: Queryable,
    p: { tenantId: string; accountId: string; key: string; dateFrom: string | null; dateTo: string | null; status: string | null; total: number | null; difal: number; charges: unknown; bonuses: unknown },
  ): Promise<void> {
    await db.query(
      `INSERT INTO ml_billing_periods (tenant_id, account_id, period_key, date_from, date_to, status, total_amount, difal, charges, bonuses, fetched_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, now())
       ON CONFLICT (tenant_id, account_id, period_key) DO UPDATE SET date_from = EXCLUDED.date_from, date_to = EXCLUDED.date_to,
         status = EXCLUDED.status, total_amount = EXCLUDED.total_amount, difal = EXCLUDED.difal, charges = EXCLUDED.charges,
         bonuses = EXCLUDED.bonuses, fetched_at = now()`,
      [p.tenantId, p.accountId, p.key, p.dateFrom, p.dateTo, p.status, p.total, p.difal, JSON.stringify(p.charges ?? []), JSON.stringify(p.bonuses ?? [])],
    );
  }
}
