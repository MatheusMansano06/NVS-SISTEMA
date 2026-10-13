import type { Queryable } from '../../../shared/infrastructure/database.js';

export interface OperatorRow {
  id: string;
  name: string;
  pin_hash: string;
  must_change_pin: boolean;
  is_active: boolean;
  failed_attempts: number;
  locked_until: Date | null;
  last_login_at: Date | null;
  created_at: Date;
}

/** Operadores da empresa (RLS por tenant). */
export class PgOperatorRepository {
  async list(db: Queryable, onlyActive = false): Promise<OperatorRow[]> {
    const { rows } = await db.query<OperatorRow>(
      `SELECT * FROM operators ${onlyActive ? 'WHERE is_active' : ''} ORDER BY is_active DESC, lower(name)`,
    );
    return rows;
  }

  async find(db: Queryable, id: string): Promise<OperatorRow | null> {
    const { rows } = await db.query<OperatorRow>('SELECT * FROM operators WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async create(db: Queryable, tenantId: string, name: string, pinHash: string, userId: string): Promise<OperatorRow> {
    const { rows } = await db.query<OperatorRow>(
      'INSERT INTO operators (tenant_id, name, pin_hash, created_by) VALUES ($1, $2, $3, $4) RETURNING *',
      [tenantId, name, pinHash, userId],
    );
    return rows[0]!;
  }

  async update(db: Queryable, id: string, p: { name?: string; active?: boolean }): Promise<OperatorRow | null> {
    const { rows } = await db.query<OperatorRow>(
      `UPDATE operators SET name = coalesce($2, name), is_active = coalesce($3, is_active) WHERE id = $1 RETURNING *`,
      [id, p.name ?? null, p.active ?? null],
    );
    return rows[0] ?? null;
  }

  async setPin(db: Queryable, id: string, pinHash: string, mustChange: boolean): Promise<void> {
    await db.query(
      'UPDATE operators SET pin_hash = $2, must_change_pin = $3, failed_attempts = 0, locked_until = NULL WHERE id = $1',
      [id, pinHash, mustChange],
    );
  }

  async loginFailed(db: Queryable, id: string, maxAttempts: number, lockMinutes: number): Promise<void> {
    await db.query(
      `UPDATE operators SET
         failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END,
         locked_until = CASE WHEN failed_attempts + 1 >= $2 THEN now() + make_interval(mins => $3) ELSE locked_until END
       WHERE id = $1`,
      [id, maxAttempts, lockMinutes],
    );
  }

  async loginOk(db: Queryable, id: string): Promise<void> {
    await db.query('UPDATE operators SET failed_attempts = 0, locked_until = NULL, last_login_at = now() WHERE id = $1', [id]);
  }
}
