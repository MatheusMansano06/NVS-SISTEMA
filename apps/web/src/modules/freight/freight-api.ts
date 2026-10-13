import type { FlexOpportunitiesDto, FreightRadarDto } from '@nvs/shared';
import { http } from '../../shared/http';

export const freightApi = {
  radar: () => http<FreightRadarDto>('/api/v1/freight-radar'),
  refresh: () => http<{ read: number }>('/api/v1/freight-radar/refresh', { method: 'POST', body: {} }),
  opportunities: () => http<FlexOpportunitiesDto>('/api/v1/flex/opportunities'),
};
