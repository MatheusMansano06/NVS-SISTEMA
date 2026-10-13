import type { Cache } from '../../../shared/kernel/cache.js';
import type { Tenant, TenantRepository } from '../domain/tenant.js';

/** Contrato público do módulo: resolve tenants com cache (consulta quente em todo login). */
export class TenantDirectory {
  constructor(
    private readonly repo: TenantRepository,
    private readonly cache: Cache,
  ) {}

  async resolveBySlug(slug: string): Promise<Tenant | null> {
    return this.cached(`tenant:slug:${slug}`, () => this.repo.findBySlug(slug));
  }

  async resolveById(id: string): Promise<Tenant | null> {
    return this.cached(`tenant:id:${id}`, () => this.repo.findById(id));
  }

  private async cached(key: string, load: () => Promise<Tenant | null>): Promise<Tenant | null> {
    const hit = await this.cache.get<Tenant>(key);
    if (hit) return hit;
    const tenant = await load();
    if (tenant) await this.cache.set(key, tenant, 60);
    return tenant;
  }
}
