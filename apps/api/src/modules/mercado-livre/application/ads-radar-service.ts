import { setTimeout as sleep } from 'node:timers/promises';
import type { Database, Queryable } from '../../../shared/infrastructure/database.js';
import { todayIn } from '../../sales/index.js';
import { addDays, canNotify, evaluateRule, ruleMessage } from '../domain/ads-radar.js';
import type { MlAdMetrics, MlApi } from '../infrastructure/ml-api.js';
import { loadRules, loadSnapshot, ruleTargets } from './ads-radar-data.js';
import type { MlIntegrationService } from './ml-integration-service.js';

const TICK_MS = 60 * 60_000;
const SITE = 'MLB';
/** Primeira leitura: o ML guarda 90 dias por campanha; por anúncio bastam 30 (simulação e janelas de até 30 dias). */
const BACKFILL_CAMPAIGN_DAYS = 90;
const BACKFILL_ITEM_DAYS = 30;
/** Leituras seguintes: hoje (parcial) e os 2 dias anteriores, que o ML ainda ajusta. */
const RECENT_DAYS = 3;
/** Histórico usado para avaliar as regras: 30 dias + a janela anterior de 30 (sobe/cai) + folga do mês. */
const EVAL_DAYS = 62;

interface Logger {
  error(obj: unknown, msg?: string): void;
  info(obj: unknown, msg?: string): void;
}

type AdsApi = Required<Pick<MlApi, 'adCampaigns' | 'adItems'>>;

const n = (v: number | null | undefined) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
const money = (v: number | null | undefined) => Math.round(n(v) * 100) / 100;
const hasActivity = (m: MlAdMetrics | null | undefined) =>
  !!m && (n(m.cost) > 0 || n(m.clicks) > 0 || n(m.prints) > 0 || n(m.direct_amount) + n(m.indirect_amount) + n(m.organic_units_amount) > 0);

/**
 * Radar ADS: lê as métricas do Mercado Ads por campanha e por anúncio (dia a dia), avalia as regras da empresa e
 * grava os alertas. Só roda para empresas com o recurso `radar_ads` liberado. Nesta fase o robô não age no ML.
 */
export class AdsRadarService {
  private readonly pace: number;

  constructor(
    private readonly db: Database,
    private readonly ml: MlIntegrationService,
    private readonly api: AdsApi,
    private readonly log: Logger,
    opts: { paceMs?: number } = {},
  ) {
    this.pace = opts.paceMs ?? 300;
  }

  /** Lê as métricas de todas as contas ativas da empresa. Devolve quantos dias (por conta) foram gravados. */
  async syncTenant(tenantId: string): Promise<number> {
    let days = 0;
    const st = await this.ml.status(tenantId);
    for (const c of st.connections.filter((x) => x.status === 'active')) {
      days += await this.syncAccount(tenantId, c.id).catch((err) => {
        this.log.error({ err, tenantId }, 'Radar ADS: leitura das métricas falhou');
        return 0;
      });
    }
    return days;
  }

  async syncAccount(tenantId: string, connectionId: string, today = todayIn()): Promise<number> {
    const { conn } = await this.ml.accessToken(tenantId, connectionId);
    const acc = await this.db.withTenant(tenantId, async (db) =>
      (
        await db.query<{ advertiser_id: string | null; metrics_backfilled_at: Date | null }>(
          `SELECT advertiser_id, metrics_backfilled_at FROM ad_accounts WHERE account_id = $1 AND status = 'ok'`,
          [conn.account_id],
        )
      ).rows[0],
    );
    if (!acc?.advertiser_id) return 0; // sem anunciante ou sem permissão: a leitura do investimento já registra o motivo
    const backfill = !acc.metrics_backfilled_at;
    const campaignDays = backfill ? BACKFILL_CAMPAIGN_DAYS : RECENT_DAYS;
    const itemDays = backfill ? BACKFILL_ITEM_DAYS : RECENT_DAYS;

    for (let i = 0; i < campaignDays; i++) {
      const day = addDays(today, -i);
      const { token } = await this.ml.accessToken(tenantId, connectionId);
      const campaigns = await this.api.adCampaigns(token, acc.advertiser_id, SITE, day);
      const items = i < itemDays ? await this.api.adItems(token, acc.advertiser_id, SITE, day) : null;
      await this.db.withTenant(tenantId, async (db) => {
        if (i === 0) await this.saveCurrent(db, tenantId, conn.account_id, campaigns, items ?? []);
        await this.saveDay(db, tenantId, conn.account_id, day, campaigns, items);
      });
      if (this.pace) await sleep(this.pace);
    }
    await this.db.withTenant(tenantId, (db) =>
      db.query(
        `UPDATE ad_accounts SET metrics_synced_at = now(), metrics_backfilled_at = coalesce(metrics_backfilled_at, now()) WHERE account_id = $1`,
        [conn.account_id],
      ),
    );
    return campaignDays;
  }

  /** Configuração atual das campanhas e de que campanha cada anúncio faz parte. */
  private async saveCurrent(db: Queryable, tenantId: string, accountId: string, campaigns: Awaited<ReturnType<AdsApi['adCampaigns']>>, items: Awaited<ReturnType<AdsApi['adItems']>>) {
    if (campaigns.length) {
      await db.query(
        `INSERT INTO ad_campaigns (tenant_id, account_id, campaign_id, name, status, strategy, acos_target, roas_target, budget, daily_budget,
                                   automatic_budget, ml_updated_at)
         SELECT $1, $2, c.id, c.name, c.status, c.strategy, c.acos_target, c.roas_target, c.budget, c.daily_budget, coalesce(c.automatic_budget, false),
                c.last_updated
           FROM jsonb_to_recordset($3) AS c(id bigint, name text, status text, strategy text, acos_target numeric, roas_target numeric,
                                            budget numeric, daily_budget numeric, automatic_budget boolean, last_updated timestamptz)
         ON CONFLICT (tenant_id, account_id, campaign_id) DO UPDATE SET
           name = EXCLUDED.name, status = EXCLUDED.status, strategy = EXCLUDED.strategy, acos_target = EXCLUDED.acos_target,
           roas_target = EXCLUDED.roas_target, budget = EXCLUDED.budget, daily_budget = EXCLUDED.daily_budget,
           automatic_budget = EXCLUDED.automatic_budget, ml_updated_at = EXCLUDED.ml_updated_at, fetched_at = now()`,
        [tenantId, accountId, JSON.stringify(campaigns.map(({ metrics: _m, ...c }) => c))],
      );
    }
    if (items.length) {
      await db.query(
        `INSERT INTO ad_items (tenant_id, account_id, item_id, campaign_id, title, status, price, thumbnail, logistic_type)
         SELECT $1, $2, i.item_id, i.campaign_id, i.title, i.status, i.price, i.thumbnail, i.logistic_type
           FROM jsonb_to_recordset($3) AS i(item_id text, campaign_id bigint, title text, status text, price numeric, thumbnail text, logistic_type text)
         ON CONFLICT (tenant_id, account_id, item_id) DO UPDATE SET
           campaign_id = EXCLUDED.campaign_id, title = EXCLUDED.title, status = EXCLUDED.status, price = EXCLUDED.price,
           thumbnail = EXCLUDED.thumbnail, logistic_type = EXCLUDED.logistic_type, fetched_at = now()`,
        [tenantId, accountId, JSON.stringify(items.map(({ metrics: _m, ...i }) => i))],
      );
    }
  }

  /** Métricas do dia: todas as campanhas; só os anúncios que tiveram movimento (são centenas por dia). */
  private async saveDay(
    db: Queryable, tenantId: string, accountId: string, day: string,
    campaigns: Awaited<ReturnType<AdsApi['adCampaigns']>>, items: Awaited<ReturnType<AdsApi['adItems']>> | null,
  ) {
    const metrics = (m: MlAdMetrics | null | undefined) => ({
      cost: money(m?.cost), clicks: n(m?.clicks), prints: n(m?.prints), direct_amount: money(m?.direct_amount),
      indirect_amount: money(m?.indirect_amount), units: n(m?.units_quantity), organic_units: n(m?.organic_units_quantity),
      organic_amount: money(m?.organic_units_amount),
    });
    const cols = `cost numeric, clicks int, prints bigint, direct_amount numeric, indirect_amount numeric, units int, organic_units int, organic_amount numeric`;
    const set = `cost = EXCLUDED.cost, clicks = EXCLUDED.clicks, prints = EXCLUDED.prints, direct_amount = EXCLUDED.direct_amount,
      indirect_amount = EXCLUDED.indirect_amount, units = EXCLUDED.units, organic_units = EXCLUDED.organic_units,
      organic_amount = EXCLUDED.organic_amount, fetched_at = now()`;
    if (campaigns.length) {
      await db.query(
        `INSERT INTO ad_campaign_daily (tenant_id, account_id, campaign_id, day, cost, clicks, prints, direct_amount, indirect_amount, units,
                                        organic_units, organic_amount, lost_share_budget)
         SELECT $1, $2, r.id, $3, r.cost, r.clicks, r.prints, r.direct_amount, r.indirect_amount, r.units, r.organic_units, r.organic_amount, r.lost
           FROM jsonb_to_recordset($4) AS r(id bigint, ${cols}, lost numeric)
         ON CONFLICT (tenant_id, account_id, campaign_id, day) DO UPDATE SET ${set}, lost_share_budget = EXCLUDED.lost_share_budget`,
        [tenantId, accountId, day, JSON.stringify(campaigns.map((c) => ({ id: c.id, ...metrics(c.metrics), lost: c.metrics?.lost_impression_share_by_budget ?? null })))],
      );
    }
    const active = (items ?? []).filter((i) => hasActivity(i.metrics));
    if (active.length) {
      await db.query(
        `INSERT INTO ad_item_daily (tenant_id, account_id, item_id, day, campaign_id, cost, clicks, prints, direct_amount, indirect_amount, units,
                                    organic_units, organic_amount)
         SELECT $1, $2, r.item_id, $3, r.campaign_id, r.cost, r.clicks, r.prints, r.direct_amount, r.indirect_amount, r.units, r.organic_units, r.organic_amount
           FROM jsonb_to_recordset($4) AS r(item_id text, campaign_id bigint, ${cols})
         ON CONFLICT (tenant_id, account_id, item_id, day) DO UPDATE SET ${set}, campaign_id = EXCLUDED.campaign_id`,
        [tenantId, accountId, day, JSON.stringify(active.map((i) => ({ item_id: i.item_id, campaign_id: i.campaign_id ?? null, ...metrics(i.metrics) })))],
      );
    }
  }

  // ---------------------------------------------------------------- regras

  /** Avalia as regras ligadas da empresa e grava os alertas novos (respeitando o intervalo entre eles). */
  async evaluate(tenantId: string, now = new Date()): Promise<number> {
    const today = todayIn(undefined, now);
    return this.db.withTenant(tenantId, async (db) => {
      const rules = await loadRules(db, true);
      if (!rules.length) return 0;
      const snap = await loadSnapshot(db, addDays(today, -EVAL_DAYS));

      let fired = 0;
      for (const rule of rules) {
        for (const t of ruleTargets(rule, snap)) {
          const result = evaluateRule(rule.conditions, t.series, today, { acosTarget: t.acosTarget });
          if (!result.fired) continue;
          const last = await db.query<{ fired_at: Date }>(
            `SELECT fired_at FROM ad_rule_events WHERE rule_id = $1 AND campaign_id IS NOT DISTINCT FROM $2 ORDER BY fired_at DESC LIMIT 1`,
            [rule.id, t.campaign?.campaign_id ?? null],
          );
          if (!canNotify(last.rows[0]?.fired_at ?? null, now, rule.cooldown_hours)) continue;
          await db.query(
            `INSERT INTO ad_rule_events (tenant_id, rule_id, account_id, campaign_id, fired_at, "values", message) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [
              tenantId, rule.id, t.campaign?.account_id ?? rule.account_id, t.campaign?.campaign_id ?? null, now,
              JSON.stringify(result.results.map((r) => ({ ...r.condition, measured: r.value, current: r.current }))),
              ruleMessage(t.subject, result),
            ],
          );
          fired++;
        }
      }
      return fired;
    });
  }

  // ---------------------------------------------------------------- agendador

  /** Empresas com o Radar ADS liberado e conta do ML ativa. */
  private async enabledTenants(): Promise<string[]> {
    const tenants = [...new Set((await this.ml.activeConnections()).map((c) => c.tenantId))];
    if (!tenants.length) return [];
    const { rows } = await this.db.query<{ id: string }>(`SELECT id FROM tenants WHERE id = ANY($1) AND 'radar_ads' = ANY(features)`, [tenants]);
    return rows.map((r) => r.id);
  }

  /** Um ciclo por hora (só uma instância processa cada horário): lê as métricas e avalia as regras. */
  async tick(now = new Date()): Promise<void> {
    const slot = new Date(Math.floor(now.getTime() / TICK_MS) * TICK_MS);
    if (!(await this.ml.claimSlot('ads_radar', slot))) return;
    for (const tenantId of await this.enabledTenants()) {
      await this.syncTenant(tenantId);
      await this.evaluate(tenantId).catch((err) => this.log.error({ err, tenantId }, 'Radar ADS: avaliação das regras falhou'));
    }
  }

  startScheduler(): () => void {
    let timer: NodeJS.Timeout;
    const schedule = () => {
      const now = Date.now();
      // hh:27, fora dos picos das vendas (hh:00), das devoluções (a cada 10 min) e da Central de Marketing (a cada 15 min)
      let next = Math.floor(now / TICK_MS) * TICK_MS + 27 * 60_000;
      if (next <= now) next += TICK_MS;
      timer = setTimeout(() => {
        this.tick().catch((err) => this.log.error({ err }, 'Radar ADS: agendador falhou'));
        schedule();
      }, next - now);
      timer.unref();
    };
    schedule();
    return () => clearTimeout(timer);
  }
}

