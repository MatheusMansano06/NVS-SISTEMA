// API pública do módulo tenancy: outros módulos só importam daqui.
export { TenantDirectory } from './application/tenant-directory.js';
export { PgTenantRepository } from './infrastructure/pg-tenant-repository.js';
export type { Tenant } from './domain/tenant.js';
