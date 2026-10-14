import type { FinanceLinesDto, FinanceSummaryDto, LowMarginDto, LogisticBucketId, MarginBand, Marketplace, SaleStatus } from '@nvs/shared';
import { http } from '../../shared/http';

export interface FinanceFilters {
  from: string;
  to: string;
  accountId?: string;
  marketplace?: Marketplace;
  considerarFreteComprador?: boolean;
}

export interface LineFilters {
  status?: SaleStatus;
  bucket?: LogisticBucketId;
  listingType?: string;
  custo?: 'com_custo' | 'sem_custo';
  margem?: MarginBand;
  sku?: string;
  pedido?: string;
}

const qs = (f: FinanceFilters, extra: Record<string, string | number | boolean | undefined> = {}) => {
  const p = new URLSearchParams({ from: f.from, to: f.to });
  if (f.accountId) p.set('accountId', f.accountId);
  if (f.marketplace) p.set('marketplace', f.marketplace);
  if (f.considerarFreteComprador) p.set('considerarFreteComprador', 'true');
  for (const [k, v] of Object.entries(extra)) if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
  return p.toString();
};

export const financeApi = {
  summary: (f: FinanceFilters, fresh = false, signal?: AbortSignal) =>
    http<FinanceSummaryDto>(`/api/v1/finance/summary?${qs(f, { fresh: fresh || undefined })}`, { signal }),
  lines: (f: FinanceFilters, l: LineFilters, offset: number, limit: number, signal?: AbortSignal) =>
    http<FinanceLinesDto>(`/api/v1/finance/lines?${qs(f, { ...l, offset, limit })}`, { signal }),
  lowMargin: (f: FinanceFilters, signal?: AbortSignal) => http<LowMarginDto>(`/api/v1/finance/low-margin?${qs(f)}`, { signal }),
  setLowMargin: (pct: number) => http<{ pct: number }>('/api/v1/finance/low-margin/settings', { method: 'PUT', body: { pct } }),
  exportUrl: (f: FinanceFilters, l: LineFilters) => `/api/v1/finance/export?${qs(f, { ...l })}`,
};
