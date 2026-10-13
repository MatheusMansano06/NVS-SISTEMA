import type { FlexAccountDto, FlexOpportunitiesDto, FlexStatusDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { AppError } from '../../../shared/kernel/errors.js';
import type { MlApi, MlFlexPrice, MlFlexZones } from '../infrastructure/ml-api.js';
import type { ListingService } from './listing-service.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const ACCOUNT_TTL = 1800; // configuração de Flex muda pouco
const priceOf = (p: MlFlexPrice) => Number(`${p.price?.fraction ?? '0'}.${p.price?.cents ?? '0'}`);

/** Área de cobertura de uma conta, para cruzar com a localização das vendas (oportunidades). */
export interface FlexArea {
  connectionId: string;
  type: 'zone' | 'radius';
  /** Polígonos das zonas ativas: anéis de [lng, lat]. */
  polygons: number[][][];
  radiusKm: number | null;
}

/** Envios Flex: configuração da conta (zonas/raio, quanto o ML paga) e ativar/desativar por anúncio. */
export class FlexService {
  constructor(
    private readonly db: Database,
    private readonly listings: ListingService,
    private readonly ml: MlIntegrationService,
    private readonly api: MlApi,
    private readonly cache: Cache,
  ) {}

  async status(tenantId: string, refresh = false): Promise<FlexStatusDto> {
    const key = `ml:flex:${tenantId}`;
    if (!refresh) {
      const hit = await this.cache.get<{ dto: FlexStatusDto; areas: FlexArea[] }>(key);
      if (hit) return hit.dto;
    }
    return (await this.load(tenantId, key)).dto;
  }

  /** Áreas de cobertura (com polígonos) de todas as contas — usado nas oportunidades. */
  async areas(tenantId: string): Promise<FlexArea[]> {
    const key = `ml:flex:${tenantId}`;
    const hit = await this.cache.get<{ dto: FlexStatusDto; areas: FlexArea[] }>(key);
    return (hit ?? (await this.load(tenantId, key))).areas;
  }

  private async load(tenantId: string, key: string) {
    const st = await this.ml.status(tenantId);
    const accounts: FlexAccountDto[] = [];
    const areas: FlexArea[] = [];
    for (const c of st.connections.filter((x) => x.status === 'active')) {
      const { token, conn } = await this.ml.accessToken(tenantId, c.id);
      const subs = (await this.api.flexSubscriptions(token, conn.ml_user_id)).filter((s) => (s.mode ?? 'FLEX') === 'FLEX');
      for (const s of subs) {
        const type = s.configuration?.set?.coverage?.type === 'radius' ? 'radius' : 'zone';
        let coverage: FlexAccountDto['coverage'];
        let pricing: FlexAccountDto['pricing'] = [];
        if (type === 'radius') {
          const meters = await this.api.flexRadius(token, conn.ml_user_id, s.service_id);
          coverage = meters ? { type: 'radius', radiusKm: Math.round(meters / 100) / 10 } : null;
          areas.push({ connectionId: c.id, type: 'radius', polygons: [], radiusKm: coverage?.type === 'radius' ? coverage.radiusKm : null });
        } else {
          const z: MlFlexZones | null = await this.api.flexZones(token, conn.ml_user_id, s.service_id);
          const active = new Set((z?.zones ?? []).map((x) => x.id));
          const avail = (z?.availables?.zones ?? []).filter((x) => active.has(x.id));
          coverage = { type: 'zone', zones: avail.map((x) => ({ id: x.id, label: (x.label ?? x.id).replace(/_/g, ' ') })) };
          pricing = (avail[0]?.pricing?.prices ?? []).map((p) => ({
            fromKg: p.weight?.from_kg ?? null,
            toKg: p.weight?.to_kg ?? null,
            price: priceOf(p),
          }));
          areas.push({
            connectionId: c.id,
            type: 'zone',
            polygons: avail.flatMap((x) => polygonRings(x.polygon?.geometry)),
            radiusKm: null,
          });
        }
        accounts.push({
          connectionId: c.id,
          account: c.nickname,
          status: s.status ?? 'unknown',
          active: s.status === 'in',
          origin: s.origin ? { city: s.origin.city?.name ?? null, zip: s.origin.zip_code ?? null } : null,
          coverage,
          pricing,
        });
      }
    }
    const value = { dto: { accounts }, areas };
    await this.cache.set(key, value, ACCOUNT_TTL);
    return value;
  }

  /**
   * Anúncios que mais vendem para compradores dentro da sua área de Flex e ainda não têm Flex.
   * Zonas: o ponto de entrega de cada venda (latitude/longitude do envio) dentro dos polígonos.
   * Contas por raio: o ML não informa o centro, então usamos as vendas para a cidade de origem.
   */
  async opportunities(tenantId: string): Promise<FlexOpportunitiesDto> {
    const [areas, status] = await Promise.all([this.areas(tenantId), this.status(tenantId)]);
    const polygons = areas.flatMap((a) => a.polygons);
    const originCity = status.accounts.find((a) => a.active)?.origin?.city ?? null;
    const method: FlexOpportunitiesDto['method'] = polygons.length ? 'zones' : originCity ? 'city' : 'none';
    if (method === 'none') return { method, areaLabel: null, located: 0, items: [] };

    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ listing_id: string; lat: string | null; lng: string | null; city: string | null; qty: number }>(
        `SELECT i.listing_id, o.ship_lat AS lat, o.ship_lng AS lng, o.ship_city AS city, i.quantity AS qty
           FROM orders o JOIN order_items i ON i.order_id = o.id
          WHERE o.status = 'paid' AND o.ordered_at > now() - interval '90 days' AND i.listing_id IS NOT NULL
            AND ${method === 'zones' ? 'o.ship_lat IS NOT NULL' : 'o.ship_city IS NOT NULL'}`,
      );
      const norm = (s: string) => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim();
      const city = originCity ? norm(originCity) : '';
      const agg = new Map<string, { located: number; orders: number; units: number }>();
      for (const r of rows) {
        const inside =
          method === 'zones'
            ? polygons.some((poly) => pointInPolygon(Number(r.lng), Number(r.lat), poly))
            : norm(r.city ?? '') === city;
        const a = agg.get(r.listing_id) ?? { located: 0, orders: 0, units: 0 };
        a.located++;
        if (inside) {
          a.orders++;
          a.units += r.qty;
        }
        agg.set(r.listing_id, a);
      }
      const candidates = [...agg].filter(([, a]) => a.orders > 0).map(([id]) => id);
      const lst = candidates.length
        ? (
            await db.query<{ external_id: string; title: string; sku: string | null; picture_url: string | null; price: string | null }>(
              `SELECT external_id, title, sku, picture_url, price FROM listings
                WHERE external_id = ANY($1) AND status = 'active' AND NOT flex_enabled AND marketplace = 'mercado_livre'`,
              [candidates],
            )
          ).rows
        : [];
      const items = lst
        .map((l) => {
          const a = agg.get(l.external_id)!;
          return {
            id: l.external_id,
            title: l.title,
            sku: l.sku,
            pictureUrl: l.picture_url,
            price: l.price === null ? null : Number(l.price),
            ordersInArea: a.orders,
            unitsInArea: a.units,
            shareInArea: a.orders / a.located,
            categoryOk: null,
          };
        })
        .sort((x, y) => y.ordersInArea - x.ordersInArea || y.shareInArea - x.shareInArea)
        .slice(0, 60);
      const zones = status.accounts.flatMap((a) => (a.coverage?.type === 'zone' ? a.coverage.zones.map((z) => z.label) : []));
      return {
        method,
        areaLabel: method === 'zones' ? zones.join(', ') : originCity,
        located: rows.length,
        items,
      };
    });
  }

  /** Liga/desliga o Flex no anúncio (confere antes se a categoria aceita). */
  async setItem(tenantId: string, id: string, enabled: boolean) {
    const { row, token, connectionId } = await this.listings.session(tenantId, id);
    if (enabled) {
      if (row.status === 'closed') throw new AppError('Anúncio finalizado não pode receber Flex.', 'LISTING_BLOCKED', 409);
      const allowed = row.category_id ? await this.api.categoryAllowsFlex(token, row.category_id).catch(() => null) : null;
      if (allowed === false) {
        throw new AppError('A categoria deste anúncio não aceita Envios Flex no Mercado Livre.', 'LISTING_BLOCKED', 409);
      }
    }
    await this.listings.wrap(() => this.api.setFlexItem(token, id, enabled));
    await this.ml.refreshListings(tenantId, connectionId, [id]);
    return { id, flex: enabled };
  }
}

/** Anéis externos de Polygon/MultiPolygon do GeoJSON, como [lng, lat]. */
export function polygonRings(geometry: { type?: string; coordinates?: unknown } | null | undefined): number[][][] {
  if (!geometry?.coordinates) return [];
  if (geometry.type === 'Polygon') return [(geometry.coordinates as number[][][])[0]!].filter(Boolean);
  if (geometry.type === 'MultiPolygon') return (geometry.coordinates as number[][][][]).map((p) => p[0]!).filter(Boolean);
  return [];
}

/** Ponto [lng, lat] dentro do anel (ray casting). */
export function pointInPolygon(lng: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i] as [number, number];
    const [xj, yj] = ring[j] as [number, number];
    if (yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
