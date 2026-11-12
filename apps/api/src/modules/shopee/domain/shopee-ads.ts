import type { ShopeeAdsPerformance, ShopeeItem } from '../infrastructure/shopee-api.js';
import type { ShopeeAdsDay, ShopeeProductRow } from '../infrastructure/pg-shopee-repository.js';

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const round2 = (n: number) => Math.round(n * 100) / 100 + 0;

/** Linha diária do Shopee Ads (DD-MM-AAAA) → dia AAAA-MM-DD. Data ilegível fica de fora. */
export function mapAdsDay(p: ShopeeAdsPerformance): ShopeeAdsDay | null {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(p.date ?? '');
  if (!m) return null;
  return {
    day: `${m[3]}-${m[2]}-${m[1]}`,
    expense: round2(num(p.expense)),
    gmv: round2(num(p.broad_gmv)),
    clicks: Math.round(num(p.clicks)),
    impressions: Math.round(num(p.impression)),
  };
}

/** Anúncio fora do ar para os pausados do Dashboard. */
export function mapShopeeItem(i: ShopeeItem, status: string): ShopeeProductRow {
  const price = i.price_info?.[0]?.current_price ?? i.price_info?.[0]?.original_price;
  const stock = i.stock_info_v2?.summary_info?.total_available_stock;
  return {
    item_id: String(i.item_id),
    title: (i.item_name ?? '').trim() || 'Produto',
    status: (i.item_status ?? status).toUpperCase(),
    picture_url: i.image?.image_url_list?.[0] ?? null,
    price: price != null && Number.isFinite(Number(price)) ? round2(Number(price)) : null,
    available_quantity: stock != null && Number.isFinite(Number(stock)) ? Math.round(Number(stock)) : null,
  };
}
