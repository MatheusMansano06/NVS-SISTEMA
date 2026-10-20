import { EMPTY_AD_TOTALS, adMetric, type AdCondition, type AdKpisDto, type AdRuleScope, type AdTotals } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import type { AdDay } from '../domain/ads-radar.js';

/** Leitura comum ao avaliador de regras e às telas do Radar ADS. */

export interface CampaignRow {
  account_id: string;
  campaign_id: string;
  name: string;
  status: string;
  strategy: string | null;
  acos_target: string | null;
  budget: string | null;
}

export interface RuleRow {
  id: string;
  name: string;
  account_id: string | null;
  scope: AdRuleScope;
  campaign_id: string | null;
  conditions: AdCondition[];
  enabled: boolean;
  cooldown_hours: number;
}

export interface Snapshot {
  campaigns: CampaignRow[];
  /** Série diária por campanha (chave: conta:campanha). */
  series: Map<string, AdDay[]>;
}

export const campaignKey = (accountId: string, campaignId: string | number) => `${accountId}:${campaignId}`;

export async function loadSnapshot(db: Queryable, since: string): Promise<Snapshot> {
  const campaigns = (
    await db.query<CampaignRow>(
      `SELECT account_id, campaign_id::text, name, status, strategy, acos_target, budget FROM ad_campaigns ORDER BY name`,
    )
  ).rows;
  const rows = (
    await db.query<{
      account_id: string; campaign_id: string; day: string; cost: string; clicks: number; prints: string; direct_amount: string;
      indirect_amount: string; units: number; organic_units: number; organic_amount: string;
    }>(
      `SELECT account_id, campaign_id::text, to_char(day, 'YYYY-MM-DD') AS day, cost, clicks, prints, direct_amount, indirect_amount, units,
              organic_units, organic_amount
         FROM ad_campaign_daily WHERE day >= $1 ORDER BY day`,
      [since],
    )
  ).rows;
  const series = new Map<string, AdDay[]>();
  for (const r of rows) {
    const d: AdDay = {
      day: r.day, cost: Number(r.cost), clicks: r.clicks, prints: Number(r.prints), directAmount: Number(r.direct_amount),
      indirectAmount: Number(r.indirect_amount), units: r.units, organicUnits: r.organic_units, organicAmount: Number(r.organic_amount),
    };
    const k = campaignKey(r.account_id, r.campaign_id);
    const list = series.get(k);
    if (list) list.push(d);
    else series.set(k, [d]);
  }
  return { campaigns, series };
}

export async function loadRules(db: Queryable, onlyEnabled: boolean): Promise<RuleRow[]> {
  return (
    await db.query<RuleRow>(
      `SELECT id, name, account_id, scope, campaign_id::text, conditions, enabled, cooldown_hours FROM ad_rules
        ${onlyEnabled ? 'WHERE enabled' : ''} ORDER BY created_at`,
    )
  ).rows;
}

export interface RuleTarget {
  campaign: CampaignRow | null;
  series: AdDay[];
  acosTarget: number | null;
  subject: string;
}

/** O que a regra avalia: a conta inteira (soma das campanhas), cada campanha ativa ou uma campanha. */
export function ruleTargets(rule: Pick<RuleRow, 'account_id' | 'scope' | 'campaign_id'>, snap: Snapshot): RuleTarget[] {
  const inAccount = snap.campaigns.filter((c) => rule.account_id === null || c.account_id === rule.account_id);
  if (rule.scope === 'conta') {
    return [{ campaign: null, series: sumByDay(inAccount.flatMap((c) => snap.series.get(campaignKey(c.account_id, c.campaign_id)) ?? [])), acosTarget: null, subject: 'Conta' }];
  }
  return inAccount
    .filter((c) => (rule.scope === 'campanha' ? c.campaign_id === rule.campaign_id : c.status === 'active'))
    .map((c) => ({
      campaign: c,
      series: snap.series.get(campaignKey(c.account_id, c.campaign_id)) ?? [],
      acosTarget: c.acos_target === null ? null : Number(c.acos_target),
      subject: c.name,
    }));
}

/** Soma várias séries diárias numa só, dia a dia. */
export function sumByDay(rows: AdDay[]): AdDay[] {
  const map = new Map<string, AdDay>();
  for (const r of rows) {
    const acc = map.get(r.day) ?? { ...EMPTY_AD_TOTALS, day: r.day };
    for (const k of Object.keys(EMPTY_AD_TOTALS) as (keyof AdTotals)[]) acc[k] += r[k];
    map.set(r.day, acc);
  }
  return [...map.values()].sort((a, b) => a.day.localeCompare(b.day));
}

export function kpis(t: AdTotals): AdKpisDto {
  return {
    cost: adMetric('investimento', t)!,
    adsSales: adMetric('vendas_ads', t)!,
    totalSales: adMetric('receita_total', t)!,
    tacos: adMetric('tacos', t),
    acos: adMetric('acos', t),
    roas: adMetric('roas', t),
    clicks: t.clicks,
  };
}
