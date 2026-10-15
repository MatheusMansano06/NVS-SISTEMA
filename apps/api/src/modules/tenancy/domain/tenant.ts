export interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: 'active' | 'suspended';
  /** Recursos liberados (ex.: "full" = Supervisão Full). */
  features: string[];
}

export interface TenantRepository {
  findBySlug(slug: string): Promise<Tenant | null>;
  findById(id: string): Promise<Tenant | null>;
}
