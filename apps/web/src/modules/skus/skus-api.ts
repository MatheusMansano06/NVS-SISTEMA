import type { GenerateEansInput, GenerateEansResult, InternalEanDto, InternalEanListDto, SkuFilter, UpdateEanInput, SkuImportReport, SkuListDto, TaxRateDto } from '@nvs/shared';
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
  importCsv: (csv: string, dryRun: boolean, ignoreUnknown = false) =>
    http<SkuImportReport>('/api/v1/skus/import', { body: { csv, dryRun, ignoreUnknown } }),
  taxRate: () => http<TaxRateDto>('/api/v1/settings/tax-rate'),
  setTaxRate: (ratePct: number) => http<TaxRateDto>('/api/v1/settings/tax-rate', { method: 'PUT', body: { ratePct } }),
  exportUrl: '/api/v1/skus/export',
  eans: (p: { q?: string; offset: number; limit: number }) => {
    const qs = new URLSearchParams({ offset: String(p.offset), limit: String(p.limit) });
    if (p.q) qs.set('q', p.q);
    return http<InternalEanListDto>(`/api/v1/skus/eans?${qs}`);
  },
  generateEans: (items: GenerateEansInput['items']) => http<GenerateEansResult>('/api/v1/skus/eans', { body: { items } }),
  updateEan: (code: string, patch: UpdateEanInput) => http<InternalEanDto>(`/api/v1/skus/eans/${code}`, { method: 'PATCH', body: patch }),
  removeEan: (code: string) => http<void>(`/api/v1/skus/eans/${code}`, { method: 'DELETE' }),
  eanLabelsUrl: (codes: string[], qty: number, format: 'rolo_1col' | 'rolo_2col' | 'a4') =>
    `/api/v1/skus/eans/labels.pdf?${new URLSearchParams({ codes: codes.join(','), qty: String(qty), format })}`,
};
