import type { DashboardDto, DashboardQuery } from '@nvs/shared';
import type { Cache } from '../../../shared/kernel/cache.js';
import type { Database } from '../../../shared/infrastructure/database.js';
import { computeKpis } from '../domain/kpis.js';
import { granularityOf, previousRange, resolvePeriod, todayIn } from '../domain/period.js';
import type { PgSalesRepository, SalesFilter } from '../infrastructure/pg-sales-repository.js';

const CACHE_TTL_SECONDS = 30;

export class DashboardService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgSalesRepository,
    private readonly cache: Cache,
  ) {}

  async summary(tenantId: string, q: DashboardQuery, now = new Date()): Promise<DashboardDto> {
    const range = resolvePeriod(q.period, todayIn(undefined, now));
    const prev = previousRange(q.period, range);
    // versão muda quando custos são alterados (cadastro de SKUs) → cache invalidado na hora
    const version = (await this.cache.get<number>(`dash-version:${tenantId}`)) ?? 0;
    const key = `dash:${tenantId}:${version}:${q.period}:${range.from}:${q.marketplace ?? '*'}:${q.accountId ?? '*'}`;

    if (!q.fresh) {
      const hit = await this.cache.get<DashboardDto>(key);
      if (hit) return hit;
    }

    const filter: SalesFilter = { range, marketplace: q.marketplace, accountId: q.accountId };
    const granularity = granularityOf(range);

    // uma transação (RLS do tenant) e consultas independentes em sequência no mesmo client
    const dto = await this.db.withTenant(tenantId, async (db) => {
      const current = await this.repo.totals(db, filter);
      const previous = await this.repo.totals(db, { ...filter, range: prev });
      const series = await this.repo.series(db, filter, granularity);
      const topProducts = await this.repo.topProducts(db, filter, current.revenue);
      const paused = await this.repo.paused(db, filter);
      const accounts = await this.repo.accounts(db);
      const isDemo = await this.repo.hasDemoData(db);
      const missingCosts = await this.repo.hasMissingCosts(db, filter);
      return {
        range: { from: range.from, to: range.to, previousFrom: prev.from, previousTo: prev.to },
        granularity,
        kpis: computeKpis(current),
        previous: computeKpis(previous),
        series,
        topProducts,
        paused,
        accounts,
        isDemo,
        missingCosts,
        generatedAt: now.toISOString(),
      } satisfies DashboardDto;
    });

    await this.cache.set(key, dto, CACHE_TTL_SECONDS);
    return dto;
  }
}
