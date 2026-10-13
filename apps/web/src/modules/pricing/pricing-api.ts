import type { CategoryOptionDto, PricingQuoteDto, PricingSimulationDto } from '@nvs/shared';
import { http } from '../../shared/http';

export const pricingApi = {
  quote: (price: number, categoryId?: string, signal?: AbortSignal) =>
    http<PricingQuoteDto>(`/api/v1/pricing/quote?price=${price}${categoryId ? `&categoryId=${categoryId}` : ''}`, { signal }),
  categories: (q: string) => http<CategoryOptionDto[]>(`/api/v1/pricing/categories?q=${encodeURIComponent(q)}`),
  simulations: () => http<PricingSimulationDto[]>('/api/v1/pricing/simulations'),
  save: (body: {
    listingId?: string; title: string; sku?: string; listingType: 'gold_special' | 'gold_pro';
    price: number; cost: number | null; freight: number; taxPct: number; fee: number;
  }) => http<{ id: string; margin: number | null; marginPct: number | null }>('/api/v1/pricing/simulations', { body }),
  remove: (id: string) => http<void>(`/api/v1/pricing/simulations/${id}`, { method: 'DELETE' }),
};
