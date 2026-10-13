import { FREIGHT_ALERT_MIN, FREIGHT_ALERT_PCT, unitMargin, type FreightRadarDto, type FreightRadarItemDto } from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { TIMEZONE, todayIn } from '../../sales/index.js';
import { formatDimensions } from '../domain/listing-margin.js';
import type { CachedMlLookups } from '../infrastructure/cached-ml-lookups.js';
import type { PgMlRepository } from '../infrastructure/pg-ml-repository.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const MAX_PER_RUN = 800; // anúncios lidos por conta a cada leitura (os que mais vendem primeiro)
const round2 = (n: number) => Math.round(n * 100) / 100;
const num = (v: string | null | undefined) => (v === null || v === undefined ? null : Number(v));

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

interface RadarRow {
  external_id: string;
  title: string;
  sku: string | null;
  picture_url: string | null;
  price: string | null;
  current: string;
  prev: string | null;
  since: string | null;
  sales_freight_avg: string | null;
  freight_paid_ratio: string | null;
  sales_fee_avg: string | null;
  fee_amount: string | null;
  pricing_price: string | null;
  custo_unit: string | null;
  units30: string | null;
  flex_enabled: boolean;
  logistic_type: string | null;
  dimensions: string | null;
}

/**
 * Radar de Frete: guarda, uma vez por dia, quanto o ML cobra de frete em cada anúncio com frete grátis e
 * aponta as altas (≥ 30% e ≥ R$ 3) em relação à leitura anterior — ou, sem histórico ainda, ao que foi pago
 * de verdade nas vendas — com o efeito na margem e no mês.
 */
export class FreightRadarService {
  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly repo: PgMlRepository,
    private readonly lookups: CachedMlLookups,
    private readonly log: Logger,
  ) {}

  /** Lê o frete de hoje dos anúncios ativos com frete grátis (mais vendidos primeiro). */
  async snapshot(tenantId: string): Promise<number> {
    const day = todayIn();
    const st = await this.ml.status(tenantId);
    let saved = 0;
    for (const c of st.connections.filter((x) => x.status === 'active')) {
      const ids = await this.db.withTenant(tenantId, async (db) =>
        (
          await db.query<{ external_id: string }>(
            `SELECT l.external_id FROM listings l
              WHERE l.account_id = $1 AND l.status = 'active' AND l.free_shipping
                AND NOT EXISTS (SELECT 1 FROM listing_freight_history h WHERE h.listing_id = l.external_id AND h.day = $2)
              ORDER BY l.sold_quantity DESC NULLS LAST LIMIT ${MAX_PER_RUN}`,
            [c.accountId, day],
          )
        ).rows.map((r) => r.external_id),
      );
      const queue = [...ids];
      const worker = async () => {
        for (let id = queue.shift(); id; id = queue.shift()) {
          const { token, conn } = await this.ml.accessToken(tenantId, c.id);
          const cost = await this.lookups.freeShippingCost(token, tenantId, conn.ml_user_id, id, true).catch(() => null);
          if (cost === null) continue;
          await this.db.withTenant(tenantId, (db) =>
            db.query(
              `INSERT INTO listing_freight_history (tenant_id, listing_id, day, list_cost) VALUES ($1, $2, $3, $4)
               ON CONFLICT (tenant_id, listing_id, day) DO UPDATE SET list_cost = EXCLUDED.list_cost`,
              [tenantId, id, day, round2(cost)],
            ),
          );
          saved++;
        }
      };
      await Promise.all(Array.from({ length: 3 }, worker));
    }
    return saved;
  }

  async radar(tenantId: string): Promise<FreightRadarDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<RadarRow>(
        `WITH latest AS (
           SELECT DISTINCT ON (listing_id) listing_id, day, list_cost FROM listing_freight_history ORDER BY listing_id, day DESC
         ), prev AS (
           SELECT DISTINCT ON (h.listing_id) h.listing_id, h.list_cost, h.day
             FROM listing_freight_history h JOIN latest l USING (listing_id)
            WHERE h.day < l.day AND h.list_cost <> l.list_cost
            ORDER BY h.listing_id, h.day DESC
         ), sold AS (
           SELECT i.listing_id, sum(i.quantity) AS units FROM order_items i JOIN orders o ON o.id = i.order_id
            WHERE o.status = 'paid' AND o.ordered_at > now() - interval '30 days' GROUP BY 1
         )
         SELECT ls.external_id, ls.title, ls.sku, ls.picture_url, ls.price, l.list_cost AS current, p.list_cost AS prev,
                (SELECT to_char(min(h.day), 'YYYY-MM-DD') FROM listing_freight_history h
                  WHERE h.listing_id = l.listing_id AND h.day > coalesce(p.day, '-infinity'::date)) AS since,
                ls.sales_freight_avg, ls.sales_fee_avg, ls.fee_amount, ls.pricing_price, sc.custo_unit, sold.units AS units30,
                ls.flex_enabled, ls.logistic_type, ls.dimensions, ls.freight_paid_ratio
           FROM latest l
           JOIN listings ls ON ls.external_id = l.listing_id AND ls.marketplace = 'mercado_livre'
           LEFT JOIN prev p ON p.listing_id = l.listing_id
           LEFT JOIN sku_costs sc ON sc.sku = ls.sku
           LEFT JOIN sold ON sold.listing_id = l.listing_id
          WHERE ls.status = 'active'`,
      );
      const tax = await db.query<{ rate_pct: string }>(
        'SELECT rate_pct FROM tax_rate_history ORDER BY vigente_desde DESC, registrado_em DESC LIMIT 1',
      );
      const taxPct = tax.rows[0] ? Number(tax.rows[0].rate_pct) : 0;
      const last = await db.query<{ day: string | null }>(`SELECT to_char(max(day), 'YYYY-MM-DD') AS day FROM listing_freight_history`);

      const items = rows.map((r) => this.toItem(r, taxPct));
      const alerts = items
        .filter((i) => i.reference !== null && i.current - i.reference >= FREIGHT_ALERT_MIN && i.current >= i.reference * (1 + FREIGHT_ALERT_PCT))
        .sort((a, b) => (b.monthlyImpact ?? 0) - (a.monthlyImpact ?? 0) || b.current - b.reference! - (a.current - a.reference!));
      const alertIds = new Set(alerts.map((a) => a.id));
      const heavy = items
        .filter((i) => !alertIds.has(i.id) && i.freightPct !== null && i.freightPct >= 0.2)
        .sort((a, b) => (b.freightPct ?? 0) - (a.freightPct ?? 0))
        .slice(0, 30);

      // histórico (30 dias) só para o que aparece na tela
      const shown = [...alerts, ...heavy].map((i) => i.id);
      if (shown.length) {
        const h = await db.query<{ listing_id: string; day: string; cost: string }>(
          `SELECT listing_id, to_char(day, 'YYYY-MM-DD') AS day, list_cost AS cost FROM listing_freight_history
            WHERE listing_id = ANY($1) AND day > (now() AT TIME ZONE '${TIMEZONE}')::date - 30 ORDER BY day`,
          [shown],
        );
        for (const i of [...alerts, ...heavy]) {
          const k = i.currentList ? i.current / i.currentList : 1; // mesma escala do valor pago
          i.history = h.rows.filter((x) => x.listing_id === i.id).map((x) => ({ day: x.day, cost: Math.round(Number(x.cost) * k * 100) / 100 }));
        }
      }
      return { lastReading: last.rows[0]?.day ?? null, monitored: items.length, alerts, heavy };
    });
  }

  private toItem(r: RadarRow, taxPct: number): FreightRadarItemDto {
    const price = num(r.price);
    // tabela do ML × desconto que você recebe (visto nas vendas): compara pago com pago
    const ratio = num(r.freight_paid_ratio) ?? 1;
    const currentList = Number(r.current);
    const current = round2(currentList * ratio);
    const prevList = num(r.prev);
    const prev = prevList === null ? null : round2(prevList * ratio);
    const salesAvg = num(r.sales_freight_avg);
    const reference = prev ?? (salesAvg !== null && salesAvg > 0 ? round2(salesAvg) : null);
    const fee = num(r.sales_fee_avg) ?? num(r.fee_amount);
    const cost = num(r.custo_unit);
    const units = Number(r.units30 ?? 0);
    const m = (freight: number | null) =>
      unitMargin({ price, fee: fee === null ? null : round2(fee), freight, cost, taxPct, source: 'sales' }).amount;
    return {
      id: r.external_id,
      title: r.title,
      sku: r.sku,
      pictureUrl: r.picture_url,
      price,
      current,
      currentList,
      discount: ratio < 1 ? round2(1 - ratio) : null,
      reference,
      referenceSource: prev !== null ? 'history' : reference !== null ? 'sales' : null,
      since: r.since,
      marginBefore: reference === null ? null : m(reference),
      marginAfter: m(current),
      units30d: units,
      monthlyImpact: reference === null ? null : round2((current - reference) * units),
      freightPct: price ? current / price : null,
      flex: r.flex_enabled,
      full: r.logistic_type === 'fulfillment',
      dimensions: formatDimensions(r.dimensions),
      history: [],
    };
  }

  /** Uma leitura por dia (uma instância por dia, via scheduler_ticks), às 05:00 de Brasília. */
  async dailyTick(now = new Date()): Promise<boolean> {
    const slot = new Date(now);
    slot.setUTCHours(0, 0, 0, 0);
    if (!(await this.repo.claimSlot('freight_radar', slot))) return false;
    for (const tenantId of await this.repo.connectedTenants()) {
      await this.snapshot(tenantId).catch((err) => this.log.error({ err, tenantId }, 'Radar de frete: leitura falhou'));
    }
    return true;
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = new Date();
      const next = new Date(now);
      next.setUTCHours(8, 0, 0, 0); // 05:00 em São Paulo
      if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
      timer = setTimeout(() => {
        this.dailyTick().catch((err) => this.log.error({ err }, 'Radar de frete: agendador falhou'));
        schedule();
      }, next.getTime() - now.getTime());
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }
}
