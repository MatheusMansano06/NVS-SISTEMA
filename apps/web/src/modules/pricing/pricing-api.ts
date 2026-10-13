import type {
  CategoryInfoDto,
  CategoryLevelDto,
  CategoryNodeDto,
  CategoryOptionDto,
  FreightQuoteDto,
  PricingQuoteDto,
  PricingSimulationDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

export const pricingApi = {
  quote: (price: number, categoryId?: string, signal?: AbortSignal) =>
    http<PricingQuoteDto>(`/api/v1/pricing/quote?price=${price}${categoryId ? `&categoryId=${categoryId}` : ''}`, { signal }),
  categories: (q: string) => http<(CategoryOptionDto & CategoryNodeDto)[]>(`/api/v1/pricing/categories?q=${encodeURIComponent(q)}`),
  tree: (parent?: string) => http<CategoryLevelDto>(`/api/v1/pricing/category-tree${parent ? `?parent=${parent}` : ''}`),
  category: (id: string) => http<CategoryInfoDto>(`/api/v1/pricing/categories/${id}`),
  freight: (q: { price: number; type: 'gold_special' | 'gold_pro'; height: number; width: number; length: number; weight: number; categoryId?: string }, signal?: AbortSignal) =>
    http<FreightQuoteDto>(
      `/api/v1/pricing/freight?${new URLSearchParams(Object.entries(q).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))}`,
      { signal },
    ),
  simulations: () => http<PricingSimulationDto[]>('/api/v1/pricing/simulations'),
  save: (body: {
    listingId?: string; title: string; sku?: string; listingType: 'gold_special' | 'gold_pro';
    price: number; cost: number | null; freight: number; taxPct: number; fee: number;
  }) => http<{ id: string; margin: number | null; marginPct: number | null }>('/api/v1/pricing/simulations', { body }),
  remove: (id: string) => http<void>(`/api/v1/pricing/simulations/${id}`, { method: 'DELETE' }),
};
