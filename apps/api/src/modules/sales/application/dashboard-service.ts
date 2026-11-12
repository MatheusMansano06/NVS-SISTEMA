import type { AdsInfoDto, DashboardDto, DashboardQuery } from '@nvs/shared';
import type { Cache } from '../../../shared/kernel/cache.js';
import type { Database } from '../../../shared/infrastructure/database.js';
import { computeKpis } from '../domain/kpis.js';
import { granularityOf, previousRange, resolvePeriod, todayIn } from '../domain/period.js';
import type { PgSalesRepository, SalesFilter } from '../infrastructure/pg-sales-repository.js';

const CACHE_TTL_SECONDS = 30;
const brDate = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}`;
const addDays = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
};
const addMonths = (iso: string, n: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + n);
  return d.toISOString().slice(0, 10);
};

const ADS_MESSAGE: Record<Exclude<AdsInfoDto['status'], 'ok'>, string> = {
  sem_permissao: 'O Mercado Livre não liberou a leitura de publicidade para o NVS: o investimento em Ads não entra na conta.',
  sem_anunciante: 'Esta conta não tem campanhas no Mercado Ads.',
  erro: 'Não foi possível ler o Mercado Ads agora; tentamos de novo na próxima atualização.',
  sem_dados: 'O investimento em Ads aparece depois da próxima sincronização com o Mercado Livre.',
};

export class DashboardService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgSalesRepository,
    private readonly cache: Cache,
  ) {}

  async summary(tenantId: string, q: DashboardQuery, now = new Date()): Promise<DashboardDto> {
    const today = todayIn(undefined, now);
    let range = resolvePeriod(q.period, today);
    let prev = previousRange(q.period, range);
    let invoiceLabel: string | null = null;
    // fatura é do Mercado Livre: no TikTok Shop o período "fatura" fica no mês corrente
    if (q.period === 'invoice' && (q.marketplace ?? 'mercado_livre') === 'mercado_livre') {
      // ciclo real da fatura do ML (as contas fecham em dias diferentes): o aberto hoje e o anterior
      const periods = await this.db.withTenant(tenantId, (db) => this.repo.invoicePeriods(db, today, q.accountId));
      const last = periods[0];
      if (last && last.to < today) {
        // a fatura do ciclo aberto ainda não foi lida: o ciclo atual começa no dia seguinte ao fechamento da última
        const from = addDays(last.to, 1);
        const end = addDays(addMonths(from, 1), -1);
        range = { from, to: today };
        prev = { from: last.from, to: last.to };
        invoiceLabel = `Fatura ${brDate(from)} a ${brDate(end)}`;
      } else if (last) {
        range = { from: last.from, to: today };
        prev = periods[1] ? { from: periods[1].from, to: periods[1].to } : previousRange('30d', range);
        invoiceLabel = `Fatura ${brDate(last.from)} a ${brDate(last.to)}`;
      }
    }
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
      const current = { ...(await this.repo.totals(db, filter)), ads: await this.repo.adSpend(db, filter) };
      const prevFilter = { ...filter, range: prev };
      const previous = { ...(await this.repo.totals(db, prevFilter)), ads: await this.repo.adSpend(db, prevFilter) };
      const adRows = await this.repo.adsInfo(db, q.accountId);
      const shopeeAdsError = q.marketplace === 'shopee' ? await this.repo.shopeeAdsError(db, q.accountId) : null;
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
        ads: shopeeAdsError
          ? { status: 'erro', message: `${shopeeAdsError} O Ads mostrado é a recarga de Ads descontada dos repasses.` }
          : adsInfo(adRows, q.marketplace),
        invoiceLabel,
        generatedAt: now.toISOString(),
      } satisfies DashboardDto;
    });

    await this.cache.set(key, dto, CACHE_TTL_SECONDS);
    return dto;
  }
}

/** A pior situação entre as contas manda: falta de permissão precisa aparecer para a margem não enganar. */
function adsInfo(rows: { status: string }[], marketplace?: string): AdsInfoDto {
  if (marketplace && marketplace !== 'mercado_livre') return { status: 'ok', message: null };
  const order: AdsInfoDto['status'][] = ['sem_permissao', 'erro', 'sem_anunciante', 'ok'];
  if (!rows.length) return { status: 'sem_dados', message: ADS_MESSAGE.sem_dados };
  const worst = order.find((st) => rows.some((r) => r.status === st)) ?? 'ok';
  if (worst === 'sem_anunciante' && rows.some((r) => r.status === 'ok')) return { status: 'ok', message: null };
  return { status: worst, message: worst === 'ok' ? null : ADS_MESSAGE[worst] };
}
