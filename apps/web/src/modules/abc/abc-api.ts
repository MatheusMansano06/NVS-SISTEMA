import type { AbcCurveDto, AbcPeriod } from '@nvs/shared';
import { http } from '../../shared/http';

export const abcApi = {
  curve: (period: AbcPeriod, signal?: AbortSignal) => http<AbcCurveDto>(`/api/v1/sales/abc?period=${period}`, { signal }),
};
