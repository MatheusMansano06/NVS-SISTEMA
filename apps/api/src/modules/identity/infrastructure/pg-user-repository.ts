import type { Role } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import type { UserWithSecret } from '../domain/user.js';

interface Row {
  id: string;
  tenant_id: string;
  email: string;
  name: string;
  role: Role;
  is_active: boolean;
  must_change_password: boolean;
  created_at: Date;
  password_hash: string;
}

const COLUMNS =
  'id, tenant_id, email, name, role, is_active, must_change_password, created_at, password_hash';

const toUser = (r: Row): UserWithSecret => ({
  id: r.id,
  tenantId: r.tenant_id,
  email: r.email,
  name: r.name,
  role: r.role,
  isActive: r.is_active,
  mustChangePassword: r.must_change_password,
  createdAt: r.created_at,
  passwordHash: r.password_hash,
});

/** Todas as operações recebem o client já escopado ao tenant (RLS ativo). */
export class PgUserRepository {
  async findByEmail(db: Queryable, email: string): Promise<UserWithSecret | null> {
    const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE email = $1`, [email]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async findById(db: Queryable, id: string): Promise<UserWithSecret | null> {
    const { rows } = await db.query<Row>(`SELECT ${COLUMNS} FROM users WHERE id = $1`, [id]);
    return rows[0] ? toUser(rows[0]) : null;
  }

  async list(db: Queryable, limit: number, offset: number): Promise<UserWithSecret[]> {
    const { rows } = await db.query<Row>(
      `SELECT ${COLUMNS} FROM users ORDER BY created_at DESC, id LIMIT $1 OFFSET $2`,
      [limit, offset],
    );
    return rows.map(toUser);
  }

  async insert(
    db: Queryable,
    u: {
      id?: string;
      tenantId: string;
      email: string;
      name: string;
      phone?: string;
      role: Role;
      passwordHash: string;
      mustChangePassword?: boolean;
    },
  ): Promise<UserWithSecret> {
    const { rows } = await db.query<Row>(
      `INSERT INTO users (id, tenant_id, email, name, phone, role, password_hash, must_change_password)
       VALUES (COALESCE($1, gen_random_uuid()), $2, $3, $4, $5, $6, $7, $8) RETURNING ${COLUMNS}`,
      [
        u.id ?? null,
        u.tenantId,
        u.email,
        u.name,
        u.phone ?? null,
        u.role,
        u.passwordHash,
        u.mustChangePassword ?? false,
      ],
    );
    return toUser(rows[0]!);
  }

  async updatePassword(db: Queryable, id: string, passwordHash: string): Promise<void> {
    await db.query(
      'UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1',
      [id, passwordHash],
    );
  }
}
