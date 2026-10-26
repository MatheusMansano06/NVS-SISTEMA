import {
  teamCost,
  type DreDto,
  type DreEntryDto,
  type DreEntryInput,
  type DreQuery,
} from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { computeDre, projectDre, type DreInput } from '../domain/dre.js';
import { todayIn } from '../domain/period.js';
import type { FinanceService } from './finance-service.js';

interface EntryRow {
  id: string;
  name: string;
  kind: DreEntryDto['kind'];
  category: DreEntryDto['category'];
  basis: DreEntryDto['basis'];
  amount: string;
  start_month: string;
  end_month: string | null;
  notes: string | null;
  details: DreEntryDto['details'];
}

const COLS = `id, name, kind, category, basis, amount, to_char(start_month, 'YYYY-MM') AS start_month,
              to_char(end_month, 'YYYY-MM') AS end_month, notes, details`;
const toDto = (r: EntryRow): DreEntryDto => ({
  id: r.id,
  name: r.name,
  kind: r.kind,
  category: r.category,
  basis: r.basis,
  amount: Number(r.amount),
  startMonth: r.start_month,
  endMonth: r.end_month,
  notes: r.notes,
  details: r.details ?? null,
});
// pessoa da equipe: o valor é sempre o custo real calculado (salário + encargos + benefícios)
const params = (e: DreEntryInput) => [
  e.name,
  e.kind,
  e.category,
  e.basis,
  e.details ? teamCost(e.details).total : e.amount,
  `${e.startMonth}-01`,
  e.endMonth ? `${e.endMonth}-01` : null,
  e.notes || null,
  e.details ? JSON.stringify(e.details) : null,
];

const daysIn = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
};
const prevMonth = (month: string) => {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
};

class FeatureLockedError extends AppError {
  constructor() {
    super('O DRE ainda não está liberado para a sua empresa.', 'FEATURE_LOCKED', 403);
  }
}

/** DRE simplificado: vendas do marketplace (automático) + gastos lançados pela empresa. */
export class DreService {
  constructor(
    private readonly db: Database,
    private readonly finance: FinanceService,
    private readonly today: () => string = () => todayIn(),
  ) {}

  /** Recurso liberado no Painel Master (por empresa ou plano). */
  async ensureFeature(tenantId: string): Promise<void> {
    const r = await this.db.query<{ features: string[] }>(
      'SELECT features FROM tenants WHERE id = $1',
      [tenantId],
    );
    if (!r.rows[0]?.features.includes('dre')) throw new FeatureLockedError();
  }

  async list(tenantId: string): Promise<DreEntryDto[]> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<EntryRow>(`SELECT ${COLS} FROM dre_entries ORDER BY kind, category, lower(name)`),
    );
    return rows.map(toDto);
  }

  async create(tenantId: string, userId: string, e: DreEntryInput): Promise<DreEntryDto> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<EntryRow>(
        `INSERT INTO dre_entries (tenant_id, name, kind, category, basis, amount, start_month, end_month, notes, details, created_by)
         VALUES ($10, $1, $2, $3, $4, $5, $6, $7, $8, $9, $11) RETURNING ${COLS}`,
        [...params(e), tenantId, userId],
      ),
    );
    return toDto(rows[0]!);
  }

  async update(tenantId: string, id: string, e: DreEntryInput): Promise<DreEntryDto | null> {
    const { rows } = await this.db.withTenant(tenantId, (db) =>
      db.query<EntryRow>(
        `UPDATE dre_entries SET name = $1, kind = $2, category = $3, basis = $4, amount = $5, start_month = $6,
                end_month = $7, notes = $8, details = $9, updated_at = now()
          WHERE id = $10 RETURNING ${COLS}`,
        [...params(e), id],
      ),
    );
    return rows[0] ? toDto(rows[0]) : null;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.db.withTenant(tenantId, (db) =>
      db.query('DELETE FROM dre_entries WHERE id = $1', [id]),
    );
    return Boolean(rowCount);
  }

  async dre(tenantId: string, q: DreQuery): Promise<DreDto> {
    const today = this.today();
    const days = daysIn(q.month);
    const isCurrentMonth = today.slice(0, 7) === q.month;
    const elapsed = isCurrentMonth
      ? Number(today.slice(8, 10))
      : q.month < today.slice(0, 7)
        ? days
        : 0;
    const entries = await this.list(tenantId);

    const current = await this.input(tenantId, q, q.month, entries);
    const d = computeDre(current);
    let previous: DreDto['previous'] = null;
    if (q.comparar) {
      const month = prevMonth(q.month);
      const p = computeDre(await this.input(tenantId, q, month, entries));
      previous = {
        month,
        receitaBruta: p.receitaBruta,
        lucroLiquido: p.subtotals.lucro_liquido,
        margemContribuicao: p.subtotals.margem_contribuicao,
      };
    }
    return {
      ...d,
      month: q.month,
      range: { from: `${q.month}-01`, to: `${q.month}-${String(days).padStart(2, '0')}` },
      isCurrentMonth,
      daysInMonth: days,
      elapsedDays: elapsed,
      projecao:
        isCurrentMonth && elapsed > 0 && elapsed < days
          ? projectDre(current, days / elapsed)
          : null,
      previous,
      lancamentos: entries.length,
      generatedAt: new Date().toISOString(),
    };
  }

  private async input(
    tenantId: string,
    q: DreQuery,
    month: string,
    entries: DreEntryDto[],
  ): Promise<DreInput> {
    const from = `${month}-01`;
    const to = `${month}-${String(daysIn(month)).padStart(2, '0')}`;
    const [sales, extra] = await Promise.all([
      this.finance.dreSales(tenantId, { from, to, accountId: q.accountId, fresh: q.fresh }),
      this.db.withTenant(tenantId, (db) => this.adsAndDifal(db, from, to, q.accountId)),
    ]);
    return { month, sales, ...extra, entries, estimar: q.estimarCusto };
  }

  /** Mercado Ads do mês e DIFAL da fatura do ML do mês. */
  private async adsAndDifal(db: Queryable, from: string, to: string, accountId?: string) {
    const { rows } = await db.query<{ ads: string; difal: string }>(
      `SELECT (SELECT coalesce(sum(cost), 0) FROM ad_spend_daily
                WHERE day BETWEEN $1::date AND $2::date AND ($3::uuid IS NULL OR account_id = $3)) AS ads,
              (SELECT coalesce(sum(difal), 0) FROM ml_billing_periods
                WHERE period_key = $1::date AND ($3::uuid IS NULL OR account_id = $3)) AS difal`,
      [from, to, accountId ?? null],
    );
    return { adSpend: Number(rows[0]?.ads ?? 0), difal: Number(rows[0]?.difal ?? 0) };
  }
}
