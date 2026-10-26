import {
  ABC_CLASSES,
  ABC_PERIOD_DAYS,
  classifyAbc,
  type AbcClass,
  type AbcClassSummaryDto,
  type AbcCurveDto,
  type AbcPeriod,
  type AbcPositionDto,
} from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import type { Database } from '../../../shared/infrastructure/database.js';
import { todayIn, type DateRange } from '../domain/period.js';
import type { AbcListingRow, PgAbcCurveRepository } from '../infrastructure/pg-abc-curve-repository.js';

class FeatureLockedError extends AppError {
  constructor() {
    super('A Curva ABC faz parte da aba Vendas, que ainda não está liberada para a sua empresa.', 'FEATURE_LOCKED', 403);
  }
}

export function abcRange(period: AbcPeriod, today = todayIn()): DateRange {
  const d = new Date(`${today}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - (ABC_PERIOD_DAYS[period] - 1));
  return { from: d.toISOString().slice(0, 10), to: today };
}

interface Line {
  row: AbcListingRow;
  cents: number;
  units: number;
}

/** Curva ABC dos anúncios do Mercado Livre, por faturamento e por unidades vendidas. */
export class AbcCurveService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgAbcCurveRepository,
    private readonly today: () => string = () => todayIn(),
  ) {}

  /** Faz parte do recurso Vendas (Painel Master / plano). */
  async ensureFeature(tenantId: string): Promise<void> {
    const r = await this.db.query<{ features: string[] }>('SELECT features FROM tenants WHERE id = $1', [tenantId]);
    if (!r.rows[0]?.features.includes('vendas')) throw new FeatureLockedError();
  }

  async curve(tenantId: string, period: AbcPeriod): Promise<AbcCurveDto> {
    const range = abcRange(period, this.today());
    const rows = await this.db.withTenant(tenantId, (db) => this.repo.byListing(db, range));
    const lines: Line[] = rows.map((row) => ({ row, cents: Number(row.revenue_cents), units: Number(row.units) }));

    // empate: decide pela outra medida e, por fim, pelo MLB (mesma ordem sempre)
    const byId = (a: Line, b: Line) => a.row.listing_id.localeCompare(b.row.listing_id);
    const byRevenue = classifyAbc(lines, (l) => l.cents, (a, b) => b.units - a.units || byId(a, b));
    const byUnits = classifyAbc(lines, (l) => l.units, (a, b) => b.cents - a.cents || byId(a, b));

    const totalCents = lines.reduce((s, l) => s + l.cents, 0);
    const totalUnits = lines.reduce((s, l) => s + l.units, 0);
    const summary = (pos: Map<Line, AbcPositionDto>, value: (l: Line) => number, total: number, scale: number) => {
      const out = Object.fromEntries(ABC_CLASSES.map((c) => [c, { listings: 0, value: 0, share: 0 }])) as Record<AbcClass, AbcClassSummaryDto>;
      for (const l of lines) {
        const s = out[pos.get(l)!.class];
        s.listings += 1;
        s.value += value(l);
      }
      for (const s of Object.values(out)) {
        s.share = total ? s.value / total : 0;
        s.value /= scale;
      }
      return out;
    };

    return {
      range,
      totals: { listings: lines.length, revenue: totalCents / 100, units: totalUnits },
      summary: {
        revenue: summary(byRevenue, (l) => l.cents, totalCents, 100),
        units: summary(byUnits, (l) => l.units, totalUnits, 1),
      },
      items: lines
        .sort((a, b) => byRevenue.get(a)!.rank - byRevenue.get(b)!.rank)
        .map((l) => ({
          listingId: l.row.listing_id,
          title: l.row.title,
          pictureUrl: l.row.picture_url,
          permalink: l.row.permalink,
          revenue: l.cents / 100,
          units: l.units,
          byRevenue: byRevenue.get(l)!,
          byUnits: byUnits.get(l)!,
        })),
    };
  }
}
