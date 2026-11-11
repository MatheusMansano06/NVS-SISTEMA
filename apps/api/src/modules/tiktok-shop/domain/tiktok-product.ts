/** Subconjunto do produto da busca de produtos do TikTok Shop (Product 202309). Valores monetários vêm como texto. */
export interface TiktokProduct {
  id: string;
  title?: string | null;
  /** ACTIVATE, SELLER_DEACTIVATED, PLATFORM_DEACTIVATED, FREEZE, DELETED, DRAFT, PENDING, FAILED... */
  status?: string | null;
  skus?: {
    id?: string | null;
    seller_sku?: string | null;
    price?: { tax_exclusive_price?: string | null; sale_price?: string | null } | null;
    inventory?: { quantity?: number | null }[] | null;
  }[] | null;
}

export interface TiktokProductRow {
  product_id: string;
  title: string;
  status: string;
  price: number | null;
  available_quantity: number;
}

/** Linha do catálogo: menor preço entre as variações e estoque somado. Excluído não entra (retorna null). */
export function mapTiktokProduct(p: TiktokProduct): TiktokProductRow | null {
  const status = (p.status ?? '').toUpperCase();
  if (!p.id || status === 'DELETED') return null;
  const skus = p.skus ?? [];
  const prices = skus
    .map((s) => Number(s.price?.sale_price ?? s.price?.tax_exclusive_price))
    .filter((n) => Number.isFinite(n) && n > 0);
  const stock = skus.reduce((sum, s) => sum + (s.inventory ?? []).reduce((a, i) => a + Math.max(0, Number(i.quantity) || 0), 0), 0);
  return {
    product_id: String(p.id),
    title: (p.title ?? '').trim() || 'Produto',
    status: status || 'UNKNOWN',
    price: prices.length ? Math.min(...prices) : null,
    available_quantity: stock,
  };
}
