import type { DifalSettingsDto, PaymentGroup, SaleOrdersDto, SalesOverviewDto, SalesPeriod } from '@nvs/shared';
import { http } from '../../shared/http';

const qs = (p: Record<string, string | number | undefined>) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '').map(([k, v]) => [k, String(v)])).toString();

export const salesApi = {
  overview: (p: { period: SalesPeriod; listingId?: string }, signal?: AbortSignal) =>
    http<SalesOverviewDto>(`/api/v1/sales/overview?${qs(p)}`, { signal }),
  orders: (p: { period: SalesPeriod; listingId?: string; q?: string; payment?: PaymentGroup; offset: number; limit: number }, signal?: AbortSignal) =>
    http<SaleOrdersDto>(`/api/v1/sales/orders?${qs(p)}`, { signal }),
  saveDifal: (s: DifalSettingsDto) => http<DifalSettingsDto>('/api/v1/settings/difal', { method: 'PUT', body: s }),
};
