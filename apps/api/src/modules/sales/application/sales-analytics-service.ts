import {
  DEFAULT_INTERNAL_RATES,
  UFS,
  computeDifal,
  paymentGroup,
  type DifalSettingsDto,
  type PaymentGroup,
  type SaleOrdersDto,
  type SalesOverviewDto,
  type SalesPeriod,
  type UF,
} from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { resolvePeriod, todayIn, type DateRange } from '../domain/period.js';
import type { PgSalesAnalyticsRepository } from '../infrastructure/pg-sales-analytics-repository.js';

const isUf = (s: string | null | undefined): s is UF => Boolean(s) && (UFS as readonly string[]).includes(s!);
const round2 = (n: number) => Math.round(n * 100) / 100;

export function rangeOf(period: SalesPeriod, today = todayIn()): DateRange {
  if (period === '90d') {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 89);
    return { from: d.toISOString().slice(0, 10), to: today };
  }
  return resolvePeriod(period, today);
}

/** Aba Vendas: visão geral (todos os anúncios ou um), DIFAL estimado e lista de pedidos. Tudo do banco. */
export class SalesAnalyticsService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgSalesAnalyticsRepository,
  ) {}

  async settings(tenantId: string): Promise<DifalSettingsDto> {
    const row = await this.db.withTenant(tenantId, (db) => this.repo.difalSettings(db));
    return toSettings(row);
  }

  async saveSettings(tenantId: string, userId: string, s: DifalSettingsDto | { originUf: UF; imported: boolean; internalRates: Partial<Record<UF, number>> }) {
    // guarda só o que difere do padrão (o padrão pode ser atualizado depois sem migrar dados)
    const overrides = Object.fromEntries(
      Object.entries(s.internalRates).filter(([uf, v]) => isUf(uf) && v !== undefined && v !== DEFAULT_INTERNAL_RATES[uf]),
    ) as Record<string, number>;
    await this.db.withTenant(tenantId, (db) => this.repo.saveDifalSettings(db, tenantId, userId, { ...s, internalRates: overrides }));
    return this.settings(tenantId);
  }

  async overview(tenantId: string, q: { period: SalesPeriod; listingId?: string; accountId?: string }): Promise<SalesOverviewDto> {
    const range = rangeOf(q.period);
    return this.db.withTenant(tenantId, async (db) => {
      const data = await this.repo.overview(db, { range, listingId: q.listingId, accountId: q.accountId });
      const settings = toSettings(await this.repo.difalSettings(db));
      const listing = q.listingId ? await this.repo.listing(db, q.listingId) : null;

      const payMap = new Map<PaymentGroup, number>();
      for (const p of data.payments) payMap.set(paymentGroup(p.type), (payMap.get(paymentGroup(p.type)) ?? 0) + p.orders);
      const states = data.states.filter((s) => isUf(s.uf)) as { uf: UF; orders: number; revenue: number }[];
      const located = states.reduce((a, s) => a + s.orders, 0);
      const difal = computeDifal(states.map((s) => ({ uf: s.uf, orders: s.orders, base: s.revenue })), settings);
      // projeção: mesmo mix de estados aplicado ao faturamento sem destino conhecido
      const coverage = data.kpis.orders ? located / data.kpis.orders : 1;
      const projection = difal.base > 0 && coverage < 0.999 ? round2(difal.total * (data.kpis.revenue / difal.base)) : null;

      const months = data.months.map((m) => {
        const entries = data.monthStates
          .filter((x) => x.month === m.month && isUf(x.uf))
          .map((x) => ({ uf: x.uf as UF, orders: x.orders, base: x.revenue }));
        return { ...m, difal: computeDifal(entries, settings).total };
      });

      return {
        range,
        kpis: {
          ...data.kpis,
          profitPct: data.kpis.profit !== null && data.kpis.revenue ? data.kpis.profit / data.kpis.revenue : null,
        },
        listing: listing && {
          id: listing.external_id,
          title: listing.title,
          sku: listing.sku,
          pictureUrl: listing.picture_url,
          stock: listing.available_quantity,
          sold: listing.sold_quantity,
        },
        payments: [...payMap].map(([group, orders]) => ({ group, orders })).sort((a, b) => b.orders - a.orders),
        shipping: data.shipping,
        states,
        located: { orders: located, total: data.kpis.orders },
        difal: { ...difal, settings, projection },
        months,
      };
    });
  }

  async orders(
    tenantId: string,
    q: { period: SalesPeriod; listingId?: string; accountId?: string; q?: string; payment?: PaymentGroup; offset: number; limit: number },
  ): Promise<SaleOrdersDto> {
    const range = rangeOf(q.period);
    const { rows, items, total } = await this.db.withTenant(tenantId, (db) => this.repo.orders(db, { ...q, range }));
    return {
      total,
      items: rows.map((r) => ({
        id: r.external_id,
        orderedAt: r.ordered_at.toISOString(),
        status: r.status,
        buyer: r.buyer_nickname,
        packId: r.pack_id,
        payment: paymentGroup(r.payment_type),
        installments: r.installments,
        logistic: r.logistic_bucket,
        city: r.ship_city,
        uf: r.ship_state,
        zip: r.ship_zip,
        items: items
          .filter((i) => i.order_id === r.id)
          .map((i) => ({ title: i.title, sku: i.sku, quantity: i.quantity, unitPrice: Number(i.unit_price), listingId: i.listing_id })),
        revenue: Number(r.gross),
        fee: Number(r.fee),
        freight: Number(r.freight),
        tax: Number(r.tax),
        cost: r.cost === null ? null : Number(r.cost),
        profit: r.cost === null || r.profit === null ? null : Number(r.profit),
      })),
    };
  }
}

function toSettings(row: { origin_uf: string; imported: boolean; internal_rates: Record<string, number> } | null): DifalSettingsDto {
  const rates = { ...DEFAULT_INTERNAL_RATES };
  for (const [uf, v] of Object.entries(row?.internal_rates ?? {})) if (isUf(uf)) rates[uf] = Number(v);
  return { originUf: isUf(row?.origin_uf) ? row!.origin_uf : 'SP', imported: row?.imported ?? false, internalRates: rates };
}
