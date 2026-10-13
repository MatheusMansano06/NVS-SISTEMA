import type {
  CategoryOptionDto,
  FlexStatusDto,
  ListingEditorDto,
  ListingMonthDto,
  ListingListDto,
  ListingPricingDto,
  ListingSalesDto,
  ListingTab,
  PromotionCandidatesDto,
  PromotionsDto,
  WholesaleDto,
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
  pricing: (id: string, price?: number, signal?: AbortSignal, refresh = false) => {
    const qs = new URLSearchParams();
    if (price) qs.set('price', String(price));
    if (refresh) qs.set('refresh', '1');
    return http<ListingPricingDto>(`/api/v1/listings/${enc(id)}/pricing${qs.size ? `?${qs}` : ''}`, { signal });
  },
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
  editor: (id: string) => http<ListingEditorDto>(`/api/v1/listings/${enc(id)}/editor`),
  setDescription: (id: string, text: string) =>
    http<{ ok: true }>(`/api/v1/listings/${enc(id)}/description`, { method: 'PUT', body: { text } }),
  setAttributes: (id: string, attributes: { id: string; value: string }[]) =>
    http<{ ok: true; changed: number }>(`/api/v1/listings/${enc(id)}/attributes`, { method: 'PUT', body: { attributes } }),
  setDimensions: (id: string, body: { width: number; height: number; length: number; weight: number; packageType: string }) =>
    http<{ ok: true }>(`/api/v1/listings/${enc(id)}/dimensions`, { method: 'PUT', body }),
  setPictures: (id: string, pictureIds: string[]) =>
    http<{ ok: true }>(`/api/v1/listings/${enc(id)}/pictures`, { method: 'PUT', body: { pictureIds } }),
  uploadPicture: (id: string, file: { name: string; type: string; data: string }) =>
    http<{ id: string; url: string | null }>(`/api/v1/listings/${enc(id)}/pictures/upload`, { body: file }),
  wholesale: (id: string) => http<WholesaleDto>(`/api/v1/listings/${enc(id)}/wholesale`),
  setWholesale: (id: string, tiers: { minUnits: number; price: number }[]) =>
    http<{ ok: true; tiers: number }>(`/api/v1/listings/${enc(id)}/wholesale`, { method: 'PUT', body: { tiers } }),
  monthly: (id: string) => http<ListingMonthDto[]>(`/api/v1/listings/${enc(id)}/sales/monthly`),
  setType: (id: string, type: 'gold_special' | 'gold_pro') =>
    http<{ id: string; type: string }>(`/api/v1/listings/${enc(id)}/type`, { method: 'PUT', body: { type } }),
  categories: (id: string, q: string) => http<CategoryOptionDto[]>(`/api/v1/listings/${enc(id)}/categories?q=${enc(q)}`),
  duplicate: (id: string, body: { categoryId?: string; title?: string }) =>
    http<{ id: string; permalink: string | null; status: 'paused' }>(`/api/v1/listings/${enc(id)}/duplicate`, { body }),
  remove: (id: string) => http<{ id: string; deleted: true }>(`/api/v1/listings/${enc(id)}`, { method: 'DELETE' }),
  flexStatus: (refresh = false) => http<FlexStatusDto>(`/api/v1/flex/status${refresh ? '?refresh=1' : ''}`),
  setFlex: (id: string, enabled: boolean) =>
    http<{ id: string; flex: boolean }>(`/api/v1/listings/${enc(id)}/flex`, { method: 'PUT', body: { enabled } }),
  setStatus: (id: string, status: 'active' | 'paused' | 'closed') =>
    http<{ id: string; status: string }>(`/api/v1/listings/${enc(id)}/status`, { method: 'PUT', body: { status } }),
};
