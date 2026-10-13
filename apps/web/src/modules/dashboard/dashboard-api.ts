import type { DashboardDto, Marketplace, Period } from '@nvs/shared';
import { http } from '../../shared/http';

export interface DashboardFilters {
  period: Period;
  marketplace?: Marketplace;
  accountId?: string;
}

export function fetchDashboard(f: DashboardFilters, opts: { fresh?: boolean; signal?: AbortSignal } = {}) {
  const qs = new URLSearchParams({ period: f.period });
  if (f.marketplace) qs.set('marketplace', f.marketplace);
  if (f.accountId) qs.set('accountId', f.accountId);
  if (opts.fresh) qs.set('fresh', '1');
  return http<DashboardDto>(`/api/v1/dashboard/summary?${qs}`, { signal: opts.signal });
}
