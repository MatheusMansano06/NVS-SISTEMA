import type { FlexAccountDto, FlexDashboardDto, FlexOpportunitiesDto, FlexStatusDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import type { Cache } from '../../../shared/kernel/cache.js';
import { AppError } from '../../../shared/kernel/errors.js';
import type { MlApi, MlFlexPrice, MlFlexZones } from '../infrastructure/ml-api.js';
import type { ListingService } from './listing-service.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const ACCOUNT_TTL = 1800; // configuração de Flex muda pouco
const ITEM_TTL = 3600; // Flex confirmado no ML, por anúncio
const VERIFY_MAX = 80; // candidatos conferidos no ML por consulta
const priceOf = (p: MlFlexPrice) => Number(`${p.price?.fraction ?? '0'}.${p.price?.cents ?? '0'}`);

/** Área de cobertura de uma conta, para cruzar com a localização das vendas (oportunidades). */
export interface FlexArea {
  connectionId: string;
  type: 'zone' | 'radius';
  /** Polígonos das zonas ativas: anéis de [lng, lat]. */
  polygons: number[][][];
  /** As mesmas zonas, com o nome (para o painel). Ausente em caches antigos. */
  zones?: { label: string; rings: number[][][] }[];
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
            zones: avail.map((x) => ({ label: (x.label ?? x.id).replace(/_/g, ' '), rings: polygonRings(x.polygon?.geometry) })),
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

    const found = await this.db.withTenant(tenantId, async (db) => {
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
      // anúncio que já vendeu por Flex nos últimos 30 dias quase certamente tem Flex: conferido primeiro
      const lst = candidates.length
        ? (
            await db.query<{
              external_id: string; account_id: string; title: string; sku: string | null; picture_url: string | null; price: string | null;
            }>(
              `SELECT external_id, account_id, title, sku, picture_url, price FROM listings
                WHERE external_id = ANY($1) AND status = 'active' AND NOT flex_enabled AND marketplace = 'mercado_livre'`,
              [candidates],
            )
          ).rows
        : [];
      return { located: rows.length, agg, lst };
    });

    const ranked = found.lst
      .map((l) => ({ l, a: found.agg.get(l.external_id)! }))
      .sort((x, y) => y.a.orders - x.a.orders || y.a.orders / y.a.located - x.a.orders / x.a.located)
      .slice(0, VERIFY_MAX);
    // a base pode estar desatualizada (Flex ligado direto no ML): confirma no ML e corrige o anúncio
    const hasFlex = await this.verifyFlex(tenantId, ranked.map((r) => ({ id: r.l.external_id, accountId: r.l.account_id })));
    const items = ranked
      .filter((r) => hasFlex.get(r.l.external_id) !== true)
      .slice(0, 60)
      .map(({ l, a }) => ({
        id: l.external_id,
        title: l.title,
        sku: l.sku,
        pictureUrl: l.picture_url,
        price: l.price === null ? null : Number(l.price),
        ordersInArea: a.orders,
        unitsInArea: a.units,
        shareInArea: a.orders / a.located,
        categoryOk: null,
      }));
    const zones = status.accounts.flatMap((a) => (a.coverage?.type === 'zone' ? a.coverage.zones.map((z) => z.label) : []));
    return {
      method,
      areaLabel: method === 'zones' ? zones.join(', ') : originCity,
      located: found.located,
      items,
    };
  }

  /**
   * Flex de cada anúncio direto no ML (fonte da verdade), com cache de 1h. Quem estiver diferente da base
   * é corrigido lá também, para os cards e o radar mostrarem certo. Falha na consulta: fica de fora (null).
   */
  private async verifyFlex(tenantId: string, list: { id: string; accountId: string }[]): Promise<Map<string, boolean | null>> {
    const out = new Map<string, boolean | null>();
    if (!list.length) return out;
    const conns = (await this.ml.status(tenantId)).connections.filter((c) => c.status === 'active');
    const queue = [...list];
    const fixes: { id: string; flex: boolean }[] = [];
    const worker = async () => {
      for (let it = queue.shift(); it; it = queue.shift()) {
        const key = `ml:flexitem:${tenantId}:${it.id}`;
        const hit = await this.cache.get<{ flex: boolean }>(key);
        if (hit) {
          out.set(it.id, hit.flex);
          continue;
        }
        const conn = conns.find((c) => c.accountId === it.accountId);
        if (!conn) {
          out.set(it.id, null);
          continue;
        }
        const { token } = await this.ml.accessToken(tenantId, conn.id);
        const flex = await this.api.flexItem(token, it.id).catch(() => null);
        out.set(it.id, flex);
        if (flex !== null) {
          await this.cache.set(key, { flex }, ITEM_TTL);
          if (flex) fixes.push({ id: it.id, flex });
        }
      }
    };
    await Promise.all(Array.from({ length: 6 }, worker));
    if (fixes.length) {
      await this.db.withTenant(tenantId, (db) =>
        db.query(`UPDATE listings SET flex_enabled = true WHERE external_id = ANY($1) AND marketplace = 'mercado_livre'`, [
          fixes.map((f) => f.id),
        ]),
      );
    }
    return out;
  }

  /** Painel Flex: participação do Flex nas vendas pagas, por mês, cidade, zona e anúncio. */
  async dashboard(tenantId: string, days: number): Promise<FlexDashboardDto> {
    const areas = await this.areas(tenantId).catch((): FlexArea[] => []);
    return this.db.withTenant(tenantId, async (db) => {
      const since = `now() - make_interval(days => $1::int)`;
      const totals = await db.query<{ flex: boolean; orders: number; units: string; gross: string }>(
        `SELECT logistic_bucket = 'flex' AS flex, count(*)::int AS orders, coalesce(sum(units), 0) AS units, coalesce(sum(gross_amount), 0) AS gross
           FROM orders WHERE status = 'paid' AND ordered_at >= ${since}
          GROUP BY 1`,
        [days],
      );
      const monthly = await db.query<{ month: string; gross: string; flex_gross: string; flex_orders: number }>(
        `SELECT to_char(date_trunc('month', ordered_at AT TIME ZONE 'America/Sao_Paulo'), 'YYYY-MM') AS month,
                coalesce(sum(gross_amount), 0) AS gross,
                coalesce(sum(gross_amount) FILTER (WHERE logistic_bucket = 'flex'), 0) AS flex_gross,
                count(*) FILTER (WHERE logistic_bucket = 'flex')::int AS flex_orders
           FROM orders
          WHERE status = 'paid'
            AND ordered_at >= date_trunc('month', now() AT TIME ZONE 'America/Sao_Paulo') AT TIME ZONE 'America/Sao_Paulo' - interval '5 months'
          GROUP BY 1 ORDER BY 1`,
      );
      const cities = await db.query<{ city: string; uf: string | null; orders: number; gross: string; all_orders: number }>(
        `SELECT min(ship_city) AS city, min(ship_state) AS uf,
                count(*) FILTER (WHERE logistic_bucket = 'flex')::int AS orders,
                coalesce(sum(gross_amount) FILTER (WHERE logistic_bucket = 'flex'), 0) AS gross,
                count(*)::int AS all_orders
           FROM orders
          WHERE status = 'paid' AND ordered_at >= ${since} AND ship_city IS NOT NULL
          GROUP BY lower(ship_city), ship_state
         HAVING count(*) FILTER (WHERE logistic_bucket = 'flex') > 0
          ORDER BY 3 DESC, 4 DESC LIMIT 12`,
        [days],
      );
      const unlocated = await db.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM orders
          WHERE status = 'paid' AND ordered_at >= ${since} AND logistic_bucket = 'flex' AND ship_city IS NULL`,
        [days],
      );
      const zoneList = areas.flatMap((a) => a.zones ?? []).filter((z) => z.rings.length);
      const zones: FlexDashboardDto['zones'] = [];
      if (zoneList.length) {
        const pts = await db.query<{ lat: string; lng: string; gross: string }>(
          `SELECT ship_lat AS lat, ship_lng AS lng, gross_amount AS gross FROM orders
            WHERE status = 'paid' AND ordered_at >= ${since} AND logistic_bucket = 'flex' AND ship_lat IS NOT NULL`,
          [days],
        );
        const acc = new Map(zoneList.map((z) => [z.label, { label: z.label, orders: 0, gross: 0 }]));
        for (const p of pts.rows) {
          const z = zoneList.find((zz) => zz.rings.some((r) => pointInPolygon(Number(p.lng), Number(p.lat), r)));
          if (!z) continue;
          const a = acc.get(z.label)!;
          a.orders++;
          a.gross += Number(p.gross);
        }
        zones.push(...[...acc.values()].map((z) => ({ ...z, gross: round2(z.gross) })).sort((a, b) => b.orders - a.orders));
      }
      const top = await db.query<{ id: string; title: string; sku: string | null; picture_url: string | null; orders: number; gross: string }>(
        `SELECT i.listing_id AS id, coalesce(min(l.title), min(i.title)) AS title, coalesce(min(l.sku), min(i.sku)) AS sku,
                min(l.picture_url) AS picture_url, count(DISTINCT o.id)::int AS orders,
                coalesce(sum(i.quantity * i.unit_price), 0) AS gross
           FROM orders o JOIN order_items i ON i.order_id = o.id
           LEFT JOIN listings l ON l.external_id = i.listing_id AND l.marketplace = 'mercado_livre'
          WHERE o.status = 'paid' AND o.ordered_at >= ${since} AND o.logistic_bucket = 'flex' AND i.listing_id IS NOT NULL
          GROUP BY i.listing_id ORDER BY 5 DESC, 6 DESC LIMIT 5`,
        [days],
      );
      const sum = (flex: boolean) => {
        const rs = totals.rows.filter((r) => r.flex === flex);
        return {
          orders: rs.reduce((s, r) => s + r.orders, 0),
          units: rs.reduce((s, r) => s + Number(r.units), 0),
          gross: round2(rs.reduce((s, r) => s + Number(r.gross), 0)),
        };
      };
      const flex = sum(true);
      const other = sum(false);
      // logistic_bucket nulo (sem envio consultado) cai em "não Flex" via `flex` = null
      const unknown = totals.rows.filter((r) => r.flex === null);
      const all = {
        orders: flex.orders + other.orders + unknown.reduce((s, r) => s + r.orders, 0),
        units: flex.units + other.units + unknown.reduce((s, r) => s + Number(r.units), 0),
        gross: round2(flex.gross + other.gross + unknown.reduce((s, r) => s + Number(r.gross), 0)),
      };
      return {
        days,
        total: all,
        flex,
        monthly: monthly.rows.map((m) => ({ month: m.month, gross: round2(Number(m.gross)), flexGross: round2(Number(m.flex_gross)), flexOrders: m.flex_orders })),
        cities: cities.rows.map((c) => ({
          city: c.city,
          uf: c.uf,
          orders: c.orders,
          gross: round2(Number(c.gross)),
          share: c.all_orders ? c.orders / c.all_orders : 0,
        })),
        zones,
        unlocated: unlocated.rows[0]?.n ?? 0,
        topListings: top.rows.map((t) => ({
          id: t.id,
          title: t.title,
          sku: t.sku,
          pictureUrl: t.picture_url,
          orders: t.orders,
          gross: round2(Number(t.gross)),
        })),
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

const round2 = (v: number) => Math.round(v * 100) / 100;

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
