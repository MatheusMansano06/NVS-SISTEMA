import type {
  ListingListDto,
  ListingPricingDto,
  ListingSalesDto,
  ListingTab,
  PromotionCandidatesDto,
  PromotionsDto,
} from '@nvs/shared';
import { http } from '../../shared/http';

const enc = encodeURIComponent;

export const listingsApi = {
  list: (p: { status: ListingTab; q?: string; offset: number; limit: number }, signal?: AbortSignal) => {
    const qs = new URLSearchParams({ status: p.status, offset: String(p.offset), limit: String(p.limit) });
    if (p.q) qs.set('q', p.q);
    return http<ListingListDto>(`/api/v1/listings?${qs}`, { signal });
  },
  sales: (id: string, offset: number, limit = 20) =>
    http<ListingSalesDto>(`/api/v1/listings/${enc(id)}/sales?offset=${offset}&limit=${limit}`),
  pricing: (id: string, price?: number, signal?: AbortSignal) =>
    http<ListingPricingDto>(`/api/v1/listings/${enc(id)}/pricing${price ? `?price=${price}` : ''}`, { signal }),
  setPrice: (id: string, price: number) =>
    http<{ id: string; price: number }>(`/api/v1/listings/${enc(id)}/price`, { method: 'PUT', body: { price } }),
  setStock: (id: string, quantity: number) =>
    http<{ id: string; stock: number }>(`/api/v1/listings/${enc(id)}/stock`, { method: 'PUT', body: { quantity } }),
  promotions: (refresh = false) => http<PromotionsDto>(`/api/v1/listings/promotions${refresh ? '?refresh=1' : ''}`),
  candidates: (connectionId: string, promotionId: string, type: string, refresh = false, signal?: AbortSignal) =>
    http<PromotionCandidatesDto>(
      `/api/v1/listings/promotions/${enc(connectionId)}/${enc(promotionId)}/candidates?type=${enc(type)}${refresh ? '&refresh=1' : ''}`,
      { signal },
    ),
  enroll: (connectionId: string, promotionId: string, itemId: string, body: { promotionType: string; dealPrice?: number }) =>
    http<{ ok: true }>(`/api/v1/listings/promotions/${enc(connectionId)}/${enc(promotionId)}/items/${enc(itemId)}`, { body }),
  setStatus: (id: string, status: 'active' | 'paused' | 'closed') =>
    http<{ id: string; status: string }>(`/api/v1/listings/${enc(id)}/status`, { method: 'PUT', body: { status } }),
};
