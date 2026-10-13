import type { Cache } from '../../../shared/kernel/cache.js';
import type { MlApi, MlListingFee } from './ml-api.js';

const FEES_TTL = 6 * 3600; // tabela de tarifas do ML: igual para todos, muda raramente
const FREIGHT_TTL = 3600; // frete do vendedor: depende da conta (reputação), muda pouco no dia

/**
 * Consultas de preço ao ML com cache: o Precificador e o card chamam isto a cada preço digitado,
 * então repetir o mesmo preço/categoria não gasta a cota do ML nem espera a rede.
 */
export class CachedMlLookups {
  constructor(
    private readonly api: MlApi,
    private readonly cache: Cache,
  ) {}

  private async memo<T>(key: string, ttl: number, refresh: boolean, load: () => Promise<T>): Promise<T> {
    if (!refresh) {
      const hit = await this.cache.get<{ v: T }>(key);
      if (hit) return hit.v;
    }
    const v = await load();
    await this.cache.set(key, { v }, ttl);
    return v;
  }

  listingFees(token: string, price: number, categoryId: string | null, refresh = false): Promise<MlListingFee[]> {
    return this.memo(`ml:fees:${categoryId ?? '-'}:${price.toFixed(2)}`, FEES_TTL, refresh, () =>
      this.api.listingFees(token, price, categoryId),
    );
  }

  freeShippingCost(token: string, tenantId: string, sellerId: string, itemId: string, refresh = false) {
    return this.memo(`ml:freeship:${tenantId}:${itemId}`, FREIGHT_TTL, refresh, () => this.api.freeShippingCost(token, sellerId, itemId));
  }

  freightByDimensions(
    token: string,
    tenantId: string,
    sellerId: string,
    q: { dimensions: string; price: number; type: string; freeShipping: boolean; categoryId?: string | null },
    refresh = false,
  ) {
    // o frete muda por faixa de preço, não por centavo: arredonda para a dezena
    const bucket = Math.round(q.price / 10) * 10;
    return this.memo(
      `ml:freight:${tenantId}:${q.dimensions}:${q.type}:${q.categoryId ?? '-'}:${bucket}`,
      FREIGHT_TTL,
      refresh,
      () => this.api.freightByDimensions(token, sellerId, q),
    );
  }
}
