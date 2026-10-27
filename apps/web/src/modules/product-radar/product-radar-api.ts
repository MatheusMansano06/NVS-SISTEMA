import type { ProductRadarDayDto } from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/product-radar';

export const productRadarApi = {
  day: (day?: string) => http<ProductRadarDayDto>(day ? `${base}?day=${day}` : base),
  remove: (id: string) => http<void>(`${base}/products/${id}`, { method: 'DELETE' }),
};
