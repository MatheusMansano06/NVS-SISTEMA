import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadEnv } from '../src/config/env.js';
import { AdsRadarService, type MlIntegrationService } from '../src/modules/mercado-livre/index.js';
import { addDays } from '../src/modules/mercado-livre/domain/ads-radar.js';
import type { MlAdCampaign, MlAdItem } from '../src/modules/mercado-livre/infrastructure/ml-api.js';
import { todayIn } from '../src/modules/sales/domain/period.js';
import { Database } from '../src/shared/infrastructure/database.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;
const silent = { error: () => undefined, info: () => undefined };

/** Mercado Ads falso: campanha A cara (TACOS 5%), campanha B barata (TACOS 0,5%), 3 anúncios (1 parado). */
function fakeAds() {
  const calls = { campaigns: [] as string[], items: [] as string[] };
  const metrics = (cost: number) => ({ cost, clicks: 100, prints: 10_000, direct_amount: 100, indirect_amount: 0, units_quantity: 4, organic_units_quantity: 3, organic_units_amount: 100 });
  return {
    calls,
    api: {
      async adCampaigns(_t: string, advertiserId: string, _s: string, day: string): Promise<MlAdCampaign[]> {
        calls.campaigns.push(`${advertiserId}:${day}`);
        return [
          { id: 1, name: 'Campanha A', status: 'active', strategy: 'PROFITABILITY', acos_target: 3, budget: 100, metrics: metrics(10) },
          { id: 2, name: 'Campanha B', status: 'active', strategy: 'PROFITABILITY', acos_target: 5, budget: 50, metrics: metrics(1) },
        ];
      },
      async adItems(_t: string, advertiserId: string, _s: string, day: string): Promise<MlAdItem[]> {
        calls.items.push(`${advertiserId}:${day}`);
        return [
          { item_id: 'MLB1', campaign_id: 1, title: 'Viseira', status: 'active', price: 50, metrics: metrics(10) },
          { item_id: 'MLB2', campaign_id: 2, title: 'Manete', status: 'active', price: 30, metrics: metrics(1) },
          { item_id: 'MLB3', campaign_id: 2, title: 'Parado', status: 'paused', price: 10, metrics: { cost: 0, clicks: 0, prints: 0 } },
        ];
      },
    },
  };
}

describe.skipIf(!TEST_DB)('Radar ADS', () => {
  const db = new Database(TEST_DB!);
  const fake = fakeAds();
  const today = todayIn();
  const tenants: { id: string; accountId: string; advertiser: string }[] = [];
  const slots = new Set<string>();

  const newTenant = async (features: string[], advertiser: string) => {
    const cnpj = Array.from({ length: 14 }, () => randomInt(0, 10)).join('');
    const t = await db.query<{ id: string }>(
      `INSERT INTO tenants (name, slug, cnpj, features) VALUES ($1, $2, $3, $4) RETURNING id`,
      [`Ads ${cnpj}`, `ads-${cnpj}`, cnpj, features],
    );
    const id = t.rows[0]!.id;
    const accountId = await db.withTenant(id, async (c) => {
      const a = await c.query<{ id: string }>(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'LOJA', $2) RETURNING id`,
        [id, cnpj],
      );
      await c.query(`INSERT INTO ad_accounts (tenant_id, account_id, advertiser_id, status) VALUES ($1, $2, $3, 'ok')`, [id, a.rows[0]!.id, advertiser]);
      return a.rows[0]!.id;
    });
    tenants.push({ id, accountId, advertiser });
    return { id, accountId };
  };

  // integração do ML reduzida ao que o Radar ADS usa: uma conta ativa por empresa
  const ml = {
    status: async () => ({ connections: [{ id: 'conn', status: 'active' }] }),
    accessToken: async (tenantId: string) => ({ token: 'tok', conn: { account_id: tenants.find((t) => t.id === tenantId)!.accountId } }),
    activeConnections: async () => tenants.map((t) => ({ tenantId: t.id, connectionId: 'conn' })),
    claimSlot: async (job: string, slot: Date) => {
      const key = `${job}:${slot.toISOString()}`;
      if (slots.has(key)) return false;
      slots.add(key);
      return true;
    },
  } as unknown as MlIntegrationService;
  const service = new AdsRadarService(db, ml, fake.api, silent, { paceMs: 0 });

  let novaes: { id: string; accountId: string };
  beforeAll(async () => {
    novaes = await newTenant(['radar_ads'], '41238');
  });
  afterAll(async () => {
    if (tenants.length) await db.query(`DELETE FROM tenants WHERE id = ANY($1)`, [tenants.map((t) => t.id)]);
    await db.pool.end();
  });

  const count = (sql: string) => db.withTenant(novaes.id, async (c) => Number((await c.query<{ n: string }>(sql)).rows[0]!.n));

  it('primeira leitura traz 90 dias de campanhas e 30 de anúncios', async () => {
    expect(await service.syncAccount(novaes.id, 'conn', today)).toBe(90);
    expect(fake.calls.campaigns).toHaveLength(90);
    expect(fake.calls.items).toHaveLength(30);
    expect(await count(`SELECT count(*) AS n FROM ad_campaign_daily`)).toBe(180);
    expect(await count(`SELECT count(*) AS n FROM ad_item_daily`)).toBe(60); // anúncio parado não ocupa linha
    const camp = await db.withTenant(novaes.id, async (c) => (await c.query(`SELECT name, acos_target, budget FROM ad_campaigns ORDER BY campaign_id`)).rows);
    expect(camp).toEqual([
      { name: 'Campanha A', acos_target: '3.00', budget: '100.00' },
      { name: 'Campanha B', acos_target: '5.00', budget: '50.00' },
    ]);
    expect(await count(`SELECT count(*) AS n FROM ad_items WHERE campaign_id = 2`)).toBe(2);
    expect(await count(`SELECT count(*) AS n FROM ad_accounts WHERE metrics_backfilled_at IS NOT NULL`)).toBe(1);
  });

  it('leituras seguintes relêem só os 3 últimos dias', async () => {
    fake.calls.campaigns.length = 0;
    fake.calls.items.length = 0;
    await service.syncAccount(novaes.id, 'conn', today);
    expect(fake.calls.campaigns).toHaveLength(3);
    expect(fake.calls.items).toHaveLength(3);
    expect(await count(`SELECT count(*) AS n FROM ad_campaign_daily`)).toBe(180); // regravou, não duplicou
  });

  it('avalia as regras, grava o alerta e respeita o intervalo', async () => {
    await db.withTenant(novaes.id, async (c) => {
      const ins = `INSERT INTO ad_rules (tenant_id, name, scope, campaign_id, conditions, enabled) VALUES ($1, $2, $3, $4, $5, $6)`;
      await c.query(ins, [novaes.id, 'TACOS alto', 'campanhas', null, JSON.stringify([{ metric: 'tacos', window: '7d', op: 'maior', value: 4 }]), true]);
      await c.query(ins, [novaes.id, 'Gasto da conta', 'conta', null, JSON.stringify([{ metric: 'investimento', window: '7d', op: 'maior', value: 50 }]), true]);
      await c.query(ins, [novaes.id, 'Acima do alvo', 'campanha', 2, JSON.stringify([{ metric: 'acos_vs_alvo', window: '7d', op: 'maior', value: 0 }]), true]);
      await c.query(ins, [novaes.id, 'Desligada', 'conta', null, JSON.stringify([{ metric: 'investimento', window: '7d', op: 'maior', value: 1 }]), false]);
    });
    expect(await service.evaluate(novaes.id)).toBe(2);
    const events = await db.withTenant(novaes.id, async (c) => (await c.query<{ message: string }>(`SELECT message FROM ad_rule_events ORDER BY message`)).rows.map((r) => r.message));
    // A: 10 ÷ (100 + 100) = 5%; conta: 7 dias × R$ 11; B: ACOS 1% abaixo do alvo de 5% (não dispara)
    expect(events).toEqual([
      'Campanha A: TACOS últimos 7 dias em 5,0% (maior que 4,0%)',
      'Conta: Investimento últimos 7 dias em R$ 77,00 (maior que R$ 50,00)',
    ]);
    expect(await service.evaluate(novaes.id)).toBe(0); // dentro das 24h
  });

  it('o agendador só lê empresas com o Radar ADS liberado', async () => {
    await newTenant(['financeiro'], '99999');
    fake.calls.campaigns.length = 0;
    await service.tick(new Date());
    expect(fake.calls.campaigns.every((c) => c.startsWith('41238:'))).toBe(true);
    expect(fake.calls.campaigns.length).toBe(3);
    await service.tick(new Date()); // mesmo horário: outra instância já pegou
    expect(fake.calls.campaigns.length).toBe(3);
  });
});

function randomCnpj(): string {
  const b = Array.from({ length: 12 }, () => randomInt(0, 10));
  const dv = (n: number[]) => {
    const w = n.length === 12 ? [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2] : [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
    const r = n.reduce((a, x, i) => a + x * w[i]!, 0) % 11;
    return r < 2 ? 0 : 11 - r;
  };
  b.push(dv(b));
  b.push(dv(b));
  const c = b.join('');
  return /^(\d)\1+$/.test(c) ? randomCnpj() : c;
}

describe.skipIf(!TEST_DB)('Radar ADS: rotas', () => {
  let app: FastifyInstance;
  const db = new Database(TEST_DB!);
  const today = todayIn();
  let cookies: Record<string, string> = {};
  let tenantId = '';
  let accountId = '';
  const api = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    app.inject({ method, url: `/api/v1/ads-radar${url}`, cookies, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
    const cnpj = randomCnpj();
    const email = `ads-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    cookies = { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
    tenantId = res.json().tenant.id;
  });
  afterAll(async () => {
    await app.close();
    await db.pool.end();
  });

  it('bloqueia sem o recurso liberado', async () => {
    const res = await api('GET', '/overview');
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FEATURE_LOCKED');
  });

  it('visão da conta: sem regra da empresa nenhuma campanha é julgada', async () => {
    await db.query(`UPDATE tenants SET features = array_append(features, 'radar_ads') WHERE id = $1`, [tenantId]);
    accountId = await db.withTenant(tenantId, async (c) => {
      const a = await c.query<{ id: string }>(
        `INSERT INTO marketplace_accounts (tenant_id, marketplace, nickname, external_id) VALUES ($1, 'mercado_livre', 'LOJA', 'x1') RETURNING id`,
        [tenantId],
      );
      const acc = a.rows[0]!.id;
      await c.query(`INSERT INTO ad_accounts (tenant_id, account_id, advertiser_id, status, metrics_backfilled_at) VALUES ($1, $2, '1', 'ok', now())`, [tenantId, acc]);
      await c.query(
        `INSERT INTO ad_campaigns (tenant_id, account_id, campaign_id, name, status, acos_target) VALUES ($1, $2, 1, 'Campanha A', 'active', 3), ($1, $2, 2, 'Campanha B', 'active', 5)`,
        [tenantId, acc],
      );
      for (let i = 1; i <= 20; i++) {
        const day = addDays(today, -i);
        // A: R$ 10 de Ads, R$ 100 com Ads + R$ 100 orgânico (ACOS 10%, TACOS 5%) · B: R$ 1 (ACOS 1%)
        await c.query(
          `INSERT INTO ad_campaign_daily (tenant_id, account_id, campaign_id, day, cost, clicks, direct_amount, organic_amount)
           VALUES ($1, $2, 1, $3, 10, 100, 100, 100), ($1, $2, 2, $3, 1, 100, 100, 100)`,
          [tenantId, acc, day],
        );
        await c.query(`INSERT INTO ad_item_daily (tenant_id, account_id, item_id, day, campaign_id, cost, direct_amount) VALUES ($1, $2, 'MLB1', $3, 1, 10, 100)`, [tenantId, acc, day]);
      }
      await c.query(`INSERT INTO ad_items (tenant_id, account_id, item_id, campaign_id, title, status) VALUES ($1, $2, 'MLB1', 1, 'Viseira', 'active')`, [tenantId, acc]);
      await c.query(`INSERT INTO ad_spend_daily (tenant_id, account_id, day, cost) VALUES ($1, $2, $3, 11)`, [tenantId, acc, today]);
      return acc;
    });
    const o = (await api('GET', '/overview')).json();
    expect(o.account).toMatchObject({ status: 'ok', backfilled: true });
    expect(o.campaigns).toEqual({ ok: 2, atencao: 0, estourado: 0, total: 2 });
    // 7 dias como no ML: hoje (sem dado aqui) e os 6 anteriores
    expect(o.last7).toMatchObject({ cost: 66, tacos: 2.75, acos: 5.5 });
    expect(o.unread).toBe(0);
    const list = (await api('GET', '/campaigns')).json();
    expect(list.map((c: { name: string; status: string }) => [c.name, c.status])).toEqual([['Campanha A', 'ok'], ['Campanha B', 'ok']]);
    expect(list[0].trend).toEqual([5, 5, 5, 5, 5, 5, 5]);
  });

  let ruleId = '';
  it('cria, lista, simula e apaga regras', async () => {
    const tacos = [{ metric: 'tacos', window: '7d', op: 'maior', value: 4 }];
    expect((await api('POST', '/rules', { name: 'Sem campanha', scope: 'campanha', conditions: tacos })).statusCode).toBe(400);
    expect((await api('POST', '/rules', { name: 'Campanha de outro', scope: 'campanha', campaignId: 999, conditions: tacos })).statusCode).toBe(404);
    const created = await api('POST', '/rules', { name: 'TACOS alto', scope: 'campanhas', conditions: tacos });
    expect(created.statusCode).toBe(201);
    ruleId = created.json().id;
    const rules = (await api('GET', '/rules')).json();
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ name: 'TACOS alto', now: { ok: 1, atencao: 0, estourado: 1 }, lastFiredAt: null });

    const sim = (await api('POST', '/rules/simulate', { scope: 'campanhas', conditions: tacos, days: 14 })).json();
    expect(sim.targets.map((t: { name: string }) => t.name)).toEqual(['Campanha A']);
    expect(sim.total).toBeGreaterThan(0);

    expect((await api('PUT', `/rules/${ruleId}`, { name: 'TACOS alto', scope: 'campanhas', conditions: tacos, enabled: false })).statusCode).toBe(204);
    expect((await api('GET', '/rules')).json()[0].enabled).toBe(false);
    expect((await api('PUT', `/rules/${ruleId}`, { name: 'TACOS alto', scope: 'campanhas', conditions: tacos })).statusCode).toBe(204);
  });

  it('metas: uma por período, com ritmo e objetivo de TACOS', async () => {
    const month = `${today.slice(0, 7)}-01`;
    const first = (await api('PUT', '/goals', { kind: 'gasto_mes', periodStart: month, target: 1000 })).json();
    const again = (await api('PUT', '/goals', { kind: 'gasto_mes', periodStart: month, target: 2000 })).json();
    expect(again.id).toBe(first.id);
    await api('PUT', '/goals', { kind: 'tacos', target: 4 });
    const goals = (await api('GET', '/goals')).json();
    const spend = goals.find((g: { kind: string }) => g.kind === 'gasto_mes');
    expect(spend).toMatchObject({ target: 2000, current: 11 });
    expect(spend.pace.idealToDate).toBeGreaterThan(0);
    expect(goals.find((g: { kind: string }) => g.kind === 'tacos')).toMatchObject({ target: 4, status: 'ok' });
    expect((await api('PUT', '/goals', { kind: 'tacos', target: 400 })).statusCode).toBe(400);
  });

  it('alertas: aparecem na visão, no detalhe da campanha e podem ser lidos', async () => {
    const silentLog = { error: () => undefined, info: () => undefined };
    const service = new AdsRadarService(db, {} as MlIntegrationService, { adCampaigns: async () => [], adItems: async () => [] }, silentLog, { paceMs: 0 });
    expect(await service.evaluate(tenantId)).toBe(1);
    expect((await api('GET', '/overview')).json().unread).toBe(1);
    const events = (await api('GET', '/events')).json();
    expect(events[0]).toMatchObject({ ruleName: 'TACOS alto', campaignId: 1, read: false });

    const detail = (await api('GET', `/campaigns/${accountId}/1`)).json();
    expect(detail.campaign).toMatchObject({ name: 'Campanha A', status: 'estourado', acosTarget: 3 });
    expect(detail.series).toHaveLength(20);
    expect(detail.rules).toHaveLength(1);
    expect(detail.events).toHaveLength(1);
    expect(detail.items[0]).toMatchObject({ itemId: 'MLB1', title: 'Viseira', last7: { cost: 60 } });
    expect((await api('GET', `/campaigns/${accountId}/999`)).statusCode).toBe(404);

    expect((await api('POST', '/events/read', {})).statusCode).toBe(204);
    expect((await api('GET', '/overview')).json().unread).toBe(0);
  });

  it('apaga a regra (e os alertas dela)', async () => {
    expect((await api('DELETE', `/rules/${ruleId}`)).statusCode).toBe(204);
    expect((await api('DELETE', `/rules/${ruleId}`)).statusCode).toBe(404);
    expect((await api('GET', '/events')).json()).toEqual([]);
  });
});
