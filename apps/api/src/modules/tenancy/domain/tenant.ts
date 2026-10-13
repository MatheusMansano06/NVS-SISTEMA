export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
}

export interface TenantRepository {
  findBySlug(slug: string): Promise<Tenant | null>;
  findById(id: string): Promise<Tenant | null>;
}
