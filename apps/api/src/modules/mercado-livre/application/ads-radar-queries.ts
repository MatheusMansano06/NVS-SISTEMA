import {
  sumAdTotals,
  type AdCampaignDetailDto, type AdCampaignDto, type AdEventDto, type AdGoalDto, type AdGoalInput, type AdRuleDto, type AdRuleInput,
  type AdSimulateInput, type AdSimulationDto, type AdStatus, type AdsRadarOverviewDto,
} from '@nvs/shared';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { AppError, NotFoundError } from '../../../shared/kernel/errors.js';
import { todayIn } from '../../sales/index.js';
import {
  addDays, evaluateRule, goalPace, goalPeriod, simulateRule, statusAgainst, totalsIn, windowRange,
} from '../domain/ads-radar.js';
import { campaignKey, kpis, loadRules, loadSnapshot, ruleTargets, sumByDay, type CampaignRow, type RuleRow, type Snapshot } from './ads-radar-data.js';

/** Histórico carregado nas telas: 60 dias de simulação + a janela de 30 dias que cada dia simulado olha. */
const SCREEN_DAYS = 92;
const RANK: Record<AdStatus, number> = { ok: 0, atencao: 1, estourado: 2 };
const worst = (a: AdStatus, b: AdStatus): AdStatus => (RANK[b] > RANK[a] ? b : a);

class FeatureLockedError extends AppError {
  constructor() {
    super('O Radar ADS ainda não está liberado para a sua empresa.', 'FEATURE_LOCKED', 403);
  }
}

interface GoalRow {
  id: string;
  account_id: string | null;
  kind: AdGoalDto['kind'];
  period_start: string | null;
  target: string;
}

/** Telas do Radar ADS: visão da conta, campanhas, regras, metas, alertas e simulação. */
export class AdsRadarQueries {
  constructor(private readonly db: Database) {}

  async ensureFeature(tenantId: string): Promise<void> {
    const r = await this.db.query<{ ok: boolean }>(`SELECT 'radar_ads' = ANY(features) AS ok FROM tenants WHERE id = $1`, [tenantId]);
    if (!r.rows[0]?.ok) throw new FeatureLockedError();
  }

  async overview(tenantId: string, today = todayIn()): Promise<AdsRadarOverviewDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const snap = await loadSnapshot(db, addDays(today, -SCREEN_DAYS));
      const rules = await loadRules(db, false);
      const acc = (
        await db.query<{ status: AdsRadarOverviewDto['account']['status']; synced: Date | null; backfilled: Date | null }>(
          `SELECT status, metrics_synced_at AS synced, metrics_backfilled_at AS backfilled FROM ad_accounts ORDER BY checked_at DESC LIMIT 1`,
        )
      ).rows[0];
      const all = sumByDay([...snap.series.values()].flat());
      const prev7 = { from: addDays(today, -14), to: addDays(today, -8) };
      const statuses = this.campaignStatuses(snap, rules.filter((r) => r.enabled), today);
      const count: Record<AdStatus, number> = { ok: 0, atencao: 0, estourado: 0 };
      for (const c of snap.campaigns.filter((x) => x.status === 'active')) count[statuses.get(campaignKey(c.account_id, c.campaign_id))!]++;
      const unread = Number((await db.query<{ n: string }>(`SELECT count(*) AS n FROM ad_rule_events WHERE read_at IS NULL`)).rows[0]!.n);
      return {
        account: acc
          ? { status: acc.status, syncedAt: acc.synced?.toISOString() ?? null, backfilled: acc.backfilled !== null }
          : { status: 'sem_conta', syncedAt: null, backfilled: false },
        today,
        last7: kpis(totalsIn(all, windowRange('7d', today))),
        prev7: kpis(totalsIn(all, prev7)),
        campaigns: { ...count, total: count.ok + count.atencao + count.estourado },
        goals: await this.goalsWith(db, snap, today),
        rules: await this.rulesWith(db, rules, snap, today),
        unread,
      };
    });
  }

  async campaigns(tenantId: string, today = todayIn()): Promise<AdCampaignDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const snap = await loadSnapshot(db, addDays(today, -SCREEN_DAYS));
      const rules = (await loadRules(db, false)).filter((r) => r.enabled);
      const statuses = this.campaignStatuses(snap, rules, today);
      return snap.campaigns.map((c) => this.campaignDto(c, snap, rules, statuses, today));
    });
  }

  async campaign(tenantId: string, accountId: string, campaignId: number, today = todayIn()): Promise<AdCampaignDetailDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const snap = await loadSnapshot(db, addDays(today, -SCREEN_DAYS));
      const c = snap.campaigns.find((x) => x.account_id === accountId && x.campaign_id === String(campaignId));
      if (!c) throw new NotFoundError('Campanha não encontrada');
      const all = await loadRules(db, false);
      const enabled = all.filter((r) => r.enabled);
      const mine = all.filter((r) => appliesTo(r, c));
      const series = (snap.series.get(campaignKey(accountId, c.campaign_id)) ?? []).filter((d) => d.day >= addDays(today, -30));
      const items = (
        await db.query<{
          item_id: string; title: string | null; thumbnail: string | null; status: string | null; price: string | null;
          cost: string; clicks: string; prints: string; direct_amount: string; indirect_amount: string; units: string; organic_units: string; organic_amount: string;
        }>(
          `SELECT i.item_id, i.title, i.thumbnail, i.status, i.price,
                  coalesce(sum(d.cost), 0) AS cost, coalesce(sum(d.clicks), 0) AS clicks, coalesce(sum(d.prints), 0) AS prints,
                  coalesce(sum(d.direct_amount), 0) AS direct_amount, coalesce(sum(d.indirect_amount), 0) AS indirect_amount,
                  coalesce(sum(d.units), 0) AS units, coalesce(sum(d.organic_units), 0) AS organic_units, coalesce(sum(d.organic_amount), 0) AS organic_amount
             FROM ad_items i
             LEFT JOIN ad_item_daily d ON d.account_id = i.account_id AND d.item_id = i.item_id AND d.day BETWEEN $3 AND $4
            WHERE i.account_id = $1 AND i.campaign_id = $2
            GROUP BY i.item_id, i.title, i.thumbnail, i.status, i.price
            ORDER BY coalesce(sum(d.cost), 0) DESC`,
          [accountId, campaignId, addDays(today, -7), addDays(today, -1)],
        )
      ).rows;
      return {
        campaign: this.campaignDto(c, snap, enabled, this.campaignStatuses(snap, enabled, today), today),
        series: series.map((d) => {
          const k = kpis(d);
          return { day: d.day, cost: k.cost, adsSales: k.adsSales, totalSales: k.totalSales, tacos: k.tacos, acos: k.acos };
        }),
        rules: await this.rulesWith(db, mine, snap, today),
        events: await this.eventsOf(db, 30, { accountId, campaignId }),
        items: items.map((i) => ({
          itemId: i.item_id, title: i.title, thumbnail: i.thumbnail, status: i.status, price: i.price === null ? null : Number(i.price),
          last7: kpis({
            cost: Number(i.cost), clicks: Number(i.clicks), prints: Number(i.prints), directAmount: Number(i.direct_amount),
            indirectAmount: Number(i.indirect_amount), units: Number(i.units), organicUnits: Number(i.organic_units), organicAmount: Number(i.organic_amount),
          }),
        })),
      };
    });
  }

  // ---------------------------------------------------------------- regras

  async rules(tenantId: string, today = todayIn()): Promise<AdRuleDto[]> {
    return this.db.withTenant(tenantId, async (db) => {
      const snap = await loadSnapshot(db, addDays(today, -SCREEN_DAYS));
      return this.rulesWith(db, await loadRules(db, false), snap, today);
    });
  }

  async createRule(tenantId: string, userId: string, input: AdRuleInput): Promise<{ id: string }> {
    return this.db.withTenant(tenantId, async (db) => {
      await this.checkTargets(db, input.accountId, input.campaignId);
      const r = await db.query<{ id: string }>(
        `INSERT INTO ad_rules (tenant_id, account_id, scope, campaign_id, name, conditions, enabled, cooldown_hours, created_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
        [tenantId, input.accountId, input.scope, input.campaignId, input.name, JSON.stringify(input.conditions), input.enabled, input.cooldownHours, userId],
      );
      return { id: r.rows[0]!.id };
    });
  }

  async updateRule(tenantId: string, id: string, input: AdRuleInput): Promise<void> {
    await this.db.withTenant(tenantId, async (db) => {
      await this.checkTargets(db, input.accountId, input.campaignId);
      const r = await db.query(
        `UPDATE ad_rules SET account_id = $2, scope = $3, campaign_id = $4, name = $5, conditions = $6, enabled = $7, cooldown_hours = $8,
                updated_at = now() WHERE id = $1`,
        [id, input.accountId, input.scope, input.campaignId, input.name, JSON.stringify(input.conditions), input.enabled, input.cooldownHours],
      );
      if (!r.rowCount) throw new NotFoundError('Regra não encontrada');
    });
  }

  async deleteRule(tenantId: string, id: string): Promise<void> {
    await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query(`DELETE FROM ad_rules WHERE id = $1`, [id]);
      if (!r.rowCount) throw new NotFoundError('Regra não encontrada');
    });
  }

  /** Simula uma regra (salva ou não) nos dias já guardados. */
  async simulate(tenantId: string, input: AdSimulateInput, today = todayIn()): Promise<AdSimulationDto> {
    return this.db.withTenant(tenantId, async (db) => {
      const snap = await loadSnapshot(db, addDays(today, -SCREEN_DAYS));
      const rule = { account_id: input.accountId, scope: input.scope, campaign_id: input.campaignId === null ? null : String(input.campaignId) };
      const targets = ruleTargets(rule, snap).map((t) => ({
        campaignId: t.campaign ? Number(t.campaign.campaign_id) : null,
        name: t.subject,
        hits: simulateRule(input.conditions, t.series, today, input.days, input.cooldownHours, { acosTarget: t.acosTarget }).map((h) => h.day),
      }));
      return { days: input.days, total: targets.reduce((s, t) => s + t.hits.length, 0), targets: targets.filter((t) => t.hits.length) };
    });
  }

  // ---------------------------------------------------------------- metas

  async goals(tenantId: string, today = todayIn()): Promise<AdGoalDto[]> {
    return this.db.withTenant(tenantId, async (db) => this.goalsWith(db, await loadSnapshot(db, addDays(today, -SCREEN_DAYS)), today));
  }

  /** Cria ou troca a meta (uma por tipo, período e conta). */
  async saveGoal(tenantId: string, userId: string, input: AdGoalInput): Promise<{ id: string }> {
    return this.db.withTenant(tenantId, async (db) => {
      await this.checkTargets(db, input.accountId, null);
      const r = await db.query<{ id: string }>(
        `INSERT INTO ad_goals (tenant_id, account_id, kind, period_start, target, created_by) VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (tenant_id, COALESCE(account_id, '00000000-0000-0000-0000-000000000000'::uuid), kind, COALESCE(period_start, '2000-01-01'::date))
         DO UPDATE SET target = EXCLUDED.target, updated_at = now()
         RETURNING id`,
        [tenantId, input.accountId, input.kind, input.periodStart, input.target, userId],
      );
      return { id: r.rows[0]!.id };
    });
  }

  async deleteGoal(tenantId: string, id: string): Promise<void> {
    await this.db.withTenant(tenantId, async (db) => {
      const r = await db.query(`DELETE FROM ad_goals WHERE id = $1`, [id]);
      if (!r.rowCount) throw new NotFoundError('Meta não encontrada');
    });
  }

  // ---------------------------------------------------------------- alertas

  async events(tenantId: string, limit: number): Promise<AdEventDto[]> {
    return this.db.withTenant(tenantId, (db) => this.eventsOf(db, limit));
  }

  /** Marca alertas como lidos (sem ids: todos). */
  async markRead(tenantId: string, ids: string[] | null): Promise<void> {
    await this.db.withTenant(tenantId, (db) =>
      db.query(`UPDATE ad_rule_events SET read_at = now() WHERE read_at IS NULL AND ($1::uuid[] IS NULL OR id = ANY($1))`, [ids]),
    );
  }

  // ---------------------------------------------------------------- apoio

  /** Situação de cada campanha: pior resultado das regras que valem para ela; sem regra, ACOS de 7 dias contra o alvo. */
  private campaignStatuses(snap: Snapshot, rules: RuleRow[], today: string): Map<string, AdStatus> {
    const out = new Map<string, AdStatus>();
    for (const c of snap.campaigns) {
      const key = campaignKey(c.account_id, c.campaign_id);
      const series = snap.series.get(key) ?? [];
      const ctx = { acosTarget: c.acos_target === null ? null : Number(c.acos_target) };
      const mine = rules.filter((r) => r.scope !== 'conta' && appliesTo(r, c));
      let status: AdStatus = 'ok';
      if (mine.length) {
        for (const r of mine) status = worst(status, evaluateRule(r.conditions, series, today, ctx).status);
      } else if (ctx.acosTarget !== null) {
        const acos = kpis(totalsIn(series, windowRange('7d', today))).acos;
        status = statusAgainst(acos, 'maior', ctx.acosTarget);
      }
      out.set(key, status);
    }
    return out;
  }

  private campaignDto(c: CampaignRow, snap: Snapshot, rules: RuleRow[], statuses: Map<string, AdStatus>, today: string): AdCampaignDto {
    const key = campaignKey(c.account_id, c.campaign_id);
    const series = snap.series.get(key) ?? [];
    const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 7));
    return {
      accountId: c.account_id,
      campaignId: Number(c.campaign_id),
      name: c.name,
      mlStatus: c.status,
      status: statuses.get(key) ?? 'ok',
      acosTarget: c.acos_target === null ? null : Number(c.acos_target),
      budget: c.budget === null ? null : Number(c.budget),
      strategy: c.strategy,
      last7: kpis(totalsIn(series, windowRange('7d', today))),
      trend: days.map((d) => kpis(sumAdTotals(series.filter((x) => x.day === d))).tacos),
      rules: rules.filter((r) => appliesTo(r, c)).length,
    };
  }

  private async rulesWith(db: Queryable, rules: RuleRow[], snap: Snapshot, today: string): Promise<AdRuleDto[]> {
    if (!rules.length) return [];
    const last = new Map(
      (
        await db.query<{ rule_id: string; at: Date }>(`SELECT rule_id, max(fired_at) AS at FROM ad_rule_events WHERE rule_id = ANY($1) GROUP BY rule_id`, [
          rules.map((r) => r.id),
        ])
      ).rows.map((r) => [r.rule_id, r.at.toISOString()]),
    );
    return rules.map((r) => {
      const now: Record<AdStatus, number> = { ok: 0, atencao: 0, estourado: 0 };
      for (const t of ruleTargets(r, snap)) now[evaluateRule(r.conditions, t.series, today, { acosTarget: t.acosTarget }).status]++;
      return {
        id: r.id, name: r.name, accountId: r.account_id, scope: r.scope, campaignId: r.campaign_id === null ? null : Number(r.campaign_id),
        conditions: r.conditions, enabled: r.enabled, cooldownHours: r.cooldown_hours, now, lastFiredAt: last.get(r.id) ?? null,
      };
    });
  }

  private async goalsWith(db: Queryable, snap: Snapshot, today: string): Promise<AdGoalDto[]> {
    const goals = (
      await db.query<GoalRow>(
        `SELECT id, account_id, kind, to_char(period_start, 'YYYY-MM-DD') AS period_start, target FROM ad_goals
          WHERE period_start IS NULL OR period_start >= date_trunc('year', $1::date) ORDER BY kind, period_start`,
        [today],
      )
    ).rows;
    if (!goals.length) return [];
    // gasto do ano inteiro: vem do investimento diário por conta (o detalhe por campanha só guarda 90 dias)
    const spendRows = (
      await db.query<{ account_id: string; day: string; cost: string }>(
        `SELECT account_id, to_char(day, 'YYYY-MM-DD') AS day, cost FROM ad_spend_daily WHERE day >= date_trunc('year', $1::date)`,
        [today],
      )
    ).rows;
    return goals.map((g) => {
      const target = Number(g.target);
      const inAccount = (accountId: string) => g.account_id === null || accountId === g.account_id;
      if (g.kind === 'tacos') {
        const series = sumByDay(snap.campaigns.filter((c) => inAccount(c.account_id)).flatMap((c) => snap.series.get(campaignKey(c.account_id, c.campaign_id)) ?? []));
        const current = kpis(totalsIn(series, windowRange('mes', today))).tacos;
        return { id: g.id, accountId: g.account_id, kind: g.kind, periodStart: null, target, current, pace: null, status: statusAgainst(current, 'maior', target) };
      }
      const period = goalPeriod(g.kind, g.period_start!);
      const spent = spendRows.filter((r) => inAccount(r.account_id) && r.day >= period.from && r.day <= period.to).reduce((s, r) => s + Number(r.cost), 0);
      const pace = goalPace(target, spent, period, today);
      // acima do ritmo estoura; levemente acima (até 3%) já pede atenção
      const status: AdStatus = pace.status === 'acima' ? 'estourado' : pace.paceDiff > 0 ? 'atencao' : 'ok';
      const { idealToDate, projected, elapsed, paceDiff } = pace;
      return {
        id: g.id, accountId: g.account_id, kind: g.kind, periodStart: g.period_start, target, current: pace.spent,
        pace: { idealToDate, projected, elapsed, paceDiff, status: pace.status }, status,
      };
    });
  }

  private async eventsOf(db: Queryable, limit: number, only?: { accountId: string; campaignId: number }): Promise<AdEventDto[]> {
    const { rows } = await db.query<{
      id: string; rule_id: string; rule_name: string; account_id: string | null; campaign_id: string | null; fired_at: Date; message: string; read_at: Date | null;
    }>(
      `SELECT e.id, e.rule_id, r.name AS rule_name, e.account_id, e.campaign_id::text, e.fired_at, e.message, e.read_at
         FROM ad_rule_events e JOIN ad_rules r ON r.id = e.rule_id
        WHERE ($2::uuid IS NULL OR (e.account_id = $2 AND e.campaign_id = $3))
        ORDER BY e.fired_at DESC LIMIT $1`,
      [limit, only?.accountId ?? null, only?.campaignId ?? null],
    );
    return rows.map((e) => ({
      id: e.id, ruleId: e.rule_id, ruleName: e.rule_name, accountId: e.account_id, campaignId: e.campaign_id === null ? null : Number(e.campaign_id),
      firedAt: e.fired_at.toISOString(), message: e.message, read: e.read_at !== null,
    }));
  }

  /** A conta e a campanha da regra/meta precisam ser da empresa. */
  private async checkTargets(db: Queryable, accountId: string | null, campaignId: number | null): Promise<void> {
    if (accountId !== null && !(await db.query(`SELECT 1 FROM marketplace_accounts WHERE id = $1`, [accountId])).rowCount) {
      throw new NotFoundError('Conta não encontrada');
    }
    if (campaignId !== null) {
      const r = await db.query(`SELECT 1 FROM ad_campaigns WHERE campaign_id = $1 AND ($2::uuid IS NULL OR account_id = $2)`, [campaignId, accountId]);
      if (!r.rowCount) throw new NotFoundError('Campanha não encontrada');
    }
  }
}

/** A regra vale para a campanha? (conta: todas da conta; campanhas: cada ativa; campanha: só ela) */
function appliesTo(r: Pick<RuleRow, 'account_id' | 'scope' | 'campaign_id'>, c: CampaignRow): boolean {
  if (r.account_id !== null && r.account_id !== c.account_id) return false;
  if (r.scope === 'campanha') return r.campaign_id === c.campaign_id;
  return r.scope === 'conta' || c.status === 'active';
}
