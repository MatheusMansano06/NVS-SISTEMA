import type { SkuFilter, SkuImportReport, SkuListDto, TaxRateDto } from '@nvs/shared';
import { http } from '../../shared/http';

export const skusApi = {
  list: (p: { q?: string; filter: SkuFilter; offset: number; limit?: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ filter: p.filter, offset: String(p.offset), limit: String(p.limit ?? 50) });
    if (p.q) qs.set('q', p.q);
    return http<SkuListDto>(`/api/v1/skus?${qs}`, { signal });
  },
  save: (sku: string, custoUnit: number) =>
    http<{ affectedOrders: number }>('/api/v1/skus', { method: 'PUT', body: { sku, custoUnit } }),
  remove: (sku: string) => http<void>('/api/v1/skus', { method: 'DELETE', body: { sku } }),
  importCsv: (csv: string, dryRun: boolean) =>
    http<SkuImportReport>('/api/v1/skus/import', { body: { csv, dryRun } }),
  taxRate: () => http<TaxRateDto>('/api/v1/settings/tax-rate'),
  setTaxRate: (ratePct: number) => http<TaxRateDto>('/api/v1/settings/tax-rate', { method: 'PUT', body: { ratePct } }),
  exportUrl: '/api/v1/skus/export',
};
