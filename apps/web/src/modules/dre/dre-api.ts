import type { DreDto, DreEntryDto, DreEntryInput } from '@nvs/shared';
import { http } from '../../shared/http';

export interface DreOptions {
  accountId?: string;
  estimarCusto?: boolean;
  comparar?: boolean;
  fresh?: boolean;
}

export const dreApi = {
  get: (month: string, o: DreOptions = {}, signal?: AbortSignal) => {
    const p = new URLSearchParams({ month });
    if (o.accountId) p.set('accountId', o.accountId);
    if (o.estimarCusto === false) p.set('estimarCusto', 'false');
    if (o.comparar === false) p.set('comparar', 'false');
    if (o.fresh) p.set('fresh', 'true');
    return http<DreDto>(`/api/v1/dre?${p}`, { signal });
  },
  entries: () => http<DreEntryDto[]>('/api/v1/dre/entries'),
  create: (e: DreEntryInput) =>
    http<DreEntryDto>('/api/v1/dre/entries', { method: 'POST', body: e }),
  update: (id: string, e: DreEntryInput) =>
    http<DreEntryDto>(`/api/v1/dre/entries/${id}`, { method: 'PUT', body: e }),
  remove: (id: string) => http<void>(`/api/v1/dre/entries/${id}`, { method: 'DELETE' }),
};
