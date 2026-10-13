import type { Database } from '../../../shared/infrastructure/database.js';
import type { Tenant, TenantRepository } from '../domain/tenant.js';

export class PgTenantRepository implements TenantRepository {
  constructor(private readonly db: Database) {}

  async findBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.db.query<Tenant>(
      'SELECT id, name, slug, status FROM tenants WHERE slug = $1',
      [slug],
    );
    return rows[0] ?? null;
  }

  async findById(id: string): Promise<Tenant | null> {
    const { rows } = await this.db.query<Tenant>(
      'SELECT id, name, slug, status FROM tenants WHERE id = $1',
      [id],
    );
    return rows[0] ?? null;
  }
}
