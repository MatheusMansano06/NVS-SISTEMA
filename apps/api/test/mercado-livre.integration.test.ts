import { randomBytes, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import type { MlApi, MlOrder } from '../src/modules/mercado-livre/index.js';
import type { MlItem } from '../src/modules/mercado-livre/domain/ml-order.js';
import { resolvePeriod, todayIn } from '../src/modules/sales/domain/period.js';

try {
  process.loadEnvFile(resolve(import.meta.dirname, '../../../.env'));
} catch {
  /* CI */
}
const TEST_DB = process.env.TEST_DATABASE_URL;

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

/** API falsa do Mercado Livre: 120 pedidos nos últimos 90 dias (1 a cada 18h). */
function fakeMl(sellerId: number) {
  const calls = { refresh: 0, exchange: 0, verifier: '' as string | null, desc: '', created: null as Record<string, unknown> | null, catCalls: 0, lastFreight: '', billing: 0, adCost: 0, orderFetch: {} as Record<string, number> };
  const now = Date.now();
  const orders: MlOrder[] = Array.from({ length: 120 }, (_, i) => ({
    id: 9_000_000 + i,
    status: i % 10 === 0 ? 'cancelled' : 'paid',
    date_created: new Date(now - i * 18 * 3_600_000 - 60_000).toISOString(),
    total_amount: 100,
    order_items: [{ item: { id: `MLB${i % 5}`, title: `Peça ${i % 5}`, seller_sku: `SKU-${i % 5}` }, quantity: 1, unit_price: 100, sale_fee: 12 }],
    shipping: { id: 7_000 + i },
  }));
  let refreshSeq = 0;
  const enrolled = new Set<string>();
  const flexOn = new Set<string>();
  const b2b = new Map<number, number>();
  const pkg = [{ id: 'SELLER_PACKAGE_WIDTH', name: 'Largura', value_name: '10 cm' }];
  // anúncios: MLB0..4 vendidos (ativos, com foto); MLB9001..3 pausados (P1 e P2 sem estoque)
  const catalog = new Map<string, MlItem>();
  for (let i = 0; i < 5; i++) {
    catalog.set(`MLB${i}`, {
      id: `MLB${i}`,
      title: `Peça ${i}`,
      status: 'active',
      available_quantity: 5,
      attributes: [{ id: 'SELLER_SKU', value_name: `SKU-${i}` }],
      pictures: [{ secure_url: `https://http2.mlstatic.com/foto-${i}.jpg` }],
    });
  }
  catalog.set('MLB9001', { id: 'MLB9001', title: 'Pausado sem estoque 1', status: 'paused', sub_status: ['out_of_stock'], available_quantity: 0, price: 50 });
  catalog.set('MLB9002', { id: 'MLB9002', title: 'Pausado sem estoque 2', status: 'paused', sub_status: [], available_quantity: 0, price: 60 });
  catalog.set('MLB9003', { id: 'MLB9003', title: 'Pausado com estoque', status: 'paused', sub_status: [], available_quantity: 7, price: 70, original_price: 100 });
  const api: MlApi = {
    async updateItem(_t, id, body) {
      const it = catalog.get(id)!;
      if (body.status) it.status = String(body.status);
      return it;
    },
    async listingFees(_t, price) {
      return [
        { listing_type_id: 'gold_special', sale_fee_amount: Math.round(price * 12) / 100, sale_fee_details: { percentage_fee: 12, fixed_fee: 0 } },
        { listing_type_id: 'gold_pro', sale_fee_amount: Math.round(price * 17) / 100, sale_fee_details: { percentage_fee: 17, fixed_fee: 0 } },
      ];
    },
    async freeShippingCost() {
      return null;
    },
    async promotions() {
      return [
        { id: 'P-DEAL', type: 'DEAL', name: 'Black Friday', status: 'started', start_date: null, finish_date: null },
        { id: 'P-OLD', type: 'DEAL', name: 'Encerrada', status: 'finished' },
      ];
    },
    async promotionCandidates(_t, promotionId, _type, after) {
      expect(promotionId).toBe('P-DEAL');
      // 2 páginas para exercitar o search_after; MLB0 já inscrito some da lista
      const all = ['MLB0', 'MLB1', 'MLB2'].filter((id) => !enrolled.has(id));
      const page = after ? all.slice(2) : all.slice(0, 2);
      return {
        results: page.map((id) => ({ id, original_price: 100, suggested_discounted_price: 90, min_discounted_price: 80, max_discounted_price: 95 })),
        searchAfter: after ? null : 'p2',
      };
    },
    async itemFull(_t, id) {
      const i = catalog.get(id)!;
      return { ...i, attributes: [...(i.attributes ?? []).map((a) => ({ ...a, name: a.id })), ...pkg], pictures: [{ id: 'P1', secure_url: 'https://x/1.jpg' }] };
    },
    async description() {
      return 'Descrição atual';
    },
    async setDescription(_t, _id, text) {
      calls.desc = text;
    },
    async uploadPicture() {
      return { id: 'NOVA', url: 'https://x/nova.jpg' };
    },
    async prices() {
      return [{ id: 'STD', type: 'standard', amount: 100, currency_id: 'BRL' }];
    },
    async businessPrice(_t, _id, qty) {
      const t = [...b2b].filter(([m]) => qty >= m).sort((a, b) => b[0] - a[0])[0];
      return t ? t[1] : 100;
    },
    async setQuantityPrices(_t, _id, prices) {
      b2b.clear();
      for (const p of prices as { amount?: number; conditions?: { min_purchase_unit: number } }[]) {
        if (p.conditions) b2b.set(p.conditions.min_purchase_unit, p.amount!);
      }
    },
    async changeListingType() {},
    async flexItem(_t, id) {
      return flexOn.has(id);
    },
    async setFlexItem(_t, id, enabled) {
      if (enabled) flexOn.add(id);
      else flexOn.delete(id);
    },
    async flexSubscriptions() {
      return [{ service_id: 77, mode: 'FLEX', status: 'in', origin: { city: { name: 'São Paulo' }, zip_code: '04351030' }, configuration: { set: { coverage: { type: 'zone' } } } }];
    },
    async flexZones() {
      return {
        zones: [{ id: 'Sao_Paulo' }],
        availables: {
          zones: [
            {
              id: 'Sao_Paulo',
              label: 'Sao_Paulo',
              polygon: { geometry: { type: 'Polygon', coordinates: [[[-46.8, -23.7], [-46.4, -23.7], [-46.4, -23.4], [-46.8, -23.4], [-46.8, -23.7]]] } },
              pricing: { prices: [{ price: { fraction: '7', cents: '99' }, weight: { from_kg: null, to_kg: 0.5 } }, { price: { fraction: '8', cents: '99' }, weight: { from_kg: 0.5, to_kg: 5 } }] },
            },
            { id: 'Campinas', label: 'Campinas' },
          ],
        },
      };
    },
    async flexRadius() {
      return null;
    },
    async categoryAllowsFlex() {
      return true;
    },
    async billingPeriods() {
      const m = new Date().toISOString().slice(0, 7);
      // ciclo da fatura: do dia 1 até o fim do mês (o "Fatura atual" do dashboard usa estas datas)
      return [{ key: `${m}-01`, period_status: 'OPEN', amount: 900, period: { date_from: `${m}-01`, date_to: `${m}-28` } }];
    },
    // Mercado Ads: R$ 10 investidos por dia
    async adAdvertisers() {
      return [{ advertiserId: '777', siteId: 'MLB' }];
    },
    async adCost() {
      calls.adCost++;
      return 10;
    },
    async billingSummary() {
      calls.billing++;
      return {
        bill_includes: {
          total_amount: 900,
          charges: [
            { label: 'Cargo por venda', amount: 800, type: 'CV' },
            { label: 'Cobrança do diferencial de alíquota interestadual (ICMS-DIFAL)', amount: 74.3, type: 'DIFAL' },
          ],
          bonuses: [{ label: 'Estorno ICMS-DIFAL', amount: 4.3 }],
        },
      };
    },
    async siteCategories() {
      calls.catCalls++;
      return [{ id: 'MLB1747', name: 'Acessórios para Veículos' }, { id: 'MLB1000', name: 'Eletrônicos' }];
    },
    async category(_t, id) {
      calls.catCalls++;
      const tree: Record<string, { name: string; children: string[] }> = {
        MLB1747: { name: 'Acessórios para Veículos', children: ['MLB8000'] },
        MLB1000: { name: 'Eletrônicos', children: [] },
        MLB8000: { name: 'Viseiras', children: [] },
      };
      const t = tree[id]!;
      return {
        id,
        name: t.name,
        path_from_root: id === 'MLB8000' ? [{ id: 'MLB1747', name: 'Acessórios para Veículos' }, { id, name: t.name }] : [{ id, name: t.name }],
        children_categories: t.children.map((c) => ({ id: c, name: tree[c]!.name })),
      };
    },
    async categoryDimensions() {
      return { height: 12, width: 25, length: 30, weight: 600 };
    },
    async freightByDimensions(_t, _s, q) {
      calls.lastFreight = q.dimensions;
      return 23.45;
    },
    async itemPromotions(_t, id) {
      return id === 'MLB9003'
        ? [
            { name: 'Antiga', status: 'finished', meli_percentage: 50 },
            { name: 'Aumente suas vendas', status: 'started', meli_percentage: 10, original_price: 100 },
          ]
        : [];
    },
    async createItem(_t, body) {
      calls.created = body;
      catalog.set('MLBDUP', { id: 'MLBDUP', title: String(body.title), status: 'active', available_quantity: 1 });
      return { id: 'MLBDUP', permalink: 'https://ml/MLBDUP' };
    },
    async searchCategories() {
      return [{ category_id: 'MLB999', category_name: 'Viseiras', domain_name: 'Capacetes' }];
    },
    async enrollPromotion(_t, itemId, body) {
      expect(body).toEqual({ promotion_id: 'P-DEAL', promotion_type: 'DEAL', deal_price: 88 });
      enrolled.add(itemId);
    },
    authorizationUrl: (state, challenge) => `https://auth.fake/authorization?state=${state}&code_challenge=${challenge}`,
    async exchangeCode(code, verifier) {
      calls.exchange++;
      calls.verifier = verifier;
      if (code !== 'codigo-bom') throw new Error('invalid_grant');
      // expira logo: força a renovação automática durante a sincronização
      return { access_token: 'AT-0', refresh_token: 'RT-0', expires_in: 60, user_id: sellerId };
    },
    async refresh(rt) {
      calls.refresh++;
      if (rt !== `RT-${refreshSeq}`) throw new Error('refresh token já usado');
      refreshSeq++;
      return { access_token: `AT-${refreshSeq}`, refresh_token: `RT-${refreshSeq}`, expires_in: 21_600, user_id: sellerId };
    },
    async me() {
      return { id: sellerId, nickname: 'LOJA TESTE ML' };
    },
    async searchOrders(_t, seller, from, to, offset) {
      expect(seller).toBe(String(sellerId));
      const f = Date.parse(from.replace('-00:00', 'Z'));
      const t = Date.parse(to.replace('-00:00', 'Z'));
      const inRange = orders.filter((o) => {
        const d = Date.parse(o.date_created);
        return d >= f && d <= t;
      });
      return { results: inRange.slice(offset, offset + 50), paging: { total: inRange.length, offset, limit: 50 } };
    },
    async order(_t, id) {
      calls.orderFetch[id] = (calls.orderFetch[id] ?? 0) + 1;
      return {
        ...orders[0]!,
        id: Number(id),
        status: 'paid',
        date_created: new Date().toISOString(),
        total_amount: 555,
        order_items: [{ item: { id: 'MLBNEW', title: 'Venda nova', seller_sku: 'NOVO' }, quantity: 1, unit_price: 555, sale_fee: 50 }],
        shipping: { id: 99_999 },
      };
    },
    // envio "Coleta" com custo de tabela 20 e frete grátis para o comprador → frete vendedor = 20
    async shipment() {
      return { logistic_type: 'drop_off', mode: 'me2', shipping_option: { cost: 0, list_cost: 20 } };
    },
    async shipmentCosts() {
      return { receiver: { save: 0, discounts: [] }, senders: [{ user_id: sellerId, cost: 20 }] };
    },
    async discounts() {
      return { details: [] };
    },
    async listingIds(_t, _seller, status, scrollId) {
      // paginação "scan" de 2 em 2 para exercitar o scroll
      const ids = [...catalog.values()].filter((i) => i.status === status).map((i) => i.id);
      const from = scrollId ? Number(scrollId) : 0;
      const page = ids.slice(from, from + 2);
      return { ids: page, scrollId: page.length ? String(from + 2) : null };
    },
    async items(_t, ids) {
      return ids
        .map((id) => catalog.get(id))
        .filter((i): i is MlItem => Boolean(i))
        .map((i) => ({ ...i, shipping: { ...(i.shipping ?? {}), tags: flexOn.has(i.id) ? ['self_service_in'] : [] } }));
    },
  };
  // pós-venda (Central de Devoluções): 1 reclamação com devolução entregue, motivo defeito, frete reverso cobrado
  const post = { shipmentLookups: 0, posts: [] as { path: string; body: unknown }[], uploads: 0 };
  const due = new Date(now + 2 * 86_400_000).toISOString();
  const claim = {
    id: 5001, resource: 'order', resource_id: 9_000_001, reason_id: 'PDD1', type: 'mediations', stage: 'claim', status: 'opened',
    date_created: new Date(now - 3 * 86_400_000).toISOString(), last_updated: new Date(now - 3_600_000).toISOString(),
    players: [{ type: 'seller', available_actions: [{ action: 'return_review_fail', due_date: due }, { action: 'return_review_ok', due_date: due }] }],
  };
  const raw: Record<string, unknown> = {
    '/post-purchase/v2/claims/5001/returns': {
      id: 'R1', status: 'delivered', last_updated: new Date(now - 7_200_000).toISOString(),
      shipments: [{ shipment_id: 43215678901, tracking_number: 'BR123456789BR', destination: { name: 'seller_address' } }],
      orders: [{ item_id: 'MLB1', return_quantity: 1 }],
    },
    '/post-purchase/v1/claims/5001/charges/return-cost': { amount: 25 },
    '/post-purchase/v1/claims/5001/affects-reputation': { affects_reputation: 'not_affected' },
    '/post-purchase/v1/claims/reasons/PDD1': { settings: { rules_engine_triage: ['defective'] } },
    '/orders/9000001': { id: 9_000_001, pack_id: 2_000_009, shipping: { id: 7_001 }, order_items: [{ item: { id: 'MLB1', title: 'Peça 1', seller_sku: 'SKU-1' } }] },
    '/post-purchase/v1/returns/R1/reviews': null,
    '/post-purchase/v1/claims/5001': claim,
    '/post-purchase/v1/returns/reasons?flow=seller_return_failed&claim_id=5001': [{ id: 'SRF2', detail: 'O produto chegou com defeito' }],
    '/shipments/7001': { id: 7_001, logistic_type: 'fulfillment' }, // venda de ida pelo Full
    '/items/MLB1': { id: 'MLB1', available_quantity: 3, shipping: { logistic_type: 'drop_off' } },
  };
  Object.assign(api, {
    async rawGet(_t: string, path: string) {
      if (path.startsWith('/post-purchase/v1/claims/search')) return { paging: { total: path.includes('status=opened') ? 1 : 0 }, data: path.includes('status=opened') ? [claim] : [] };
      if (path.startsWith('/orders/search')) return { results: [] };
      if (path === '/shipments/123456789012') {
        post.shipmentLookups++;
        return { order_id: 9_000_001 };
      }
      return raw[path] ?? null;
    },
    async rawPost(_t: string, path: string, body: unknown) {
      post.posts.push({ path, body });
      return {};
    },
    async rawPut(_t: string, path: string, body: unknown) {
      post.posts.push({ path, body });
      return {};
    },
    async rawUpload() {
      post.uploads++;
      return { file_name: `anexo-${post.uploads}.jpg`, filename: `anexo-${post.uploads}.jpg` };
    },
  });
  return { api, calls, orders, catalog, post };
}

describe.skipIf(!TEST_DB)('Integração Mercado Livre', () => {
  let app: FastifyInstance;
  const sellerId = randomInt(1_000_000, 9_999_999);
  const fake = fakeMl(sellerId);

  const account = async () => {
    const cnpj = randomCnpj();
    const email = `ml-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
  };
  const stateOf = async (cookies: Record<string, string>) => {
    const res = await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/connect', cookies });
    expect(res.statusCode).toBe(200);
    const url = new URL(res.json().url);
    expect(url.searchParams.get('code_challenge')).toMatch(/^[\w-]{43}$/); // PKCE S256
    return url.searchParams.get('state')!;
  };

  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        ML_CLIENT_ID: 'app-teste',
        ML_CLIENT_SECRET: 'segredo-teste',
        ML_REDIRECT_URI: 'https://exemplo.test/api/v1/integrations/mercado-livre/callback',
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }),
      mlApi: fake.api,
    });
  });
  afterAll(() => app.close());

  let firstCookies: Record<string, string> = {};
  it('conecta, sincroniza em etapas, renova o token e preenche o dashboard', async () => {
    const cookies = await account();
    firstCookies = cookies;
    const before = await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/status', cookies });
    expect(before.json()).toEqual({ configured: true, connections: [] });

    const state = await stateOf(cookies);
    const cb = await app.inject({ method: 'GET', url: `/api/v1/integrations/mercado-livre/callback?code=codigo-bom&state=${state}` });
    expect(cb.statusCode).toBe(302);
    expect(cb.headers.location).toBe('/?ml=connected');
    expect(fake.calls.verifier).toBeTruthy();

    await app.ml!.whenIdle();
    const status = (await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/status', cookies })).json();
    const conn = status.connections[0];
    expect(conn).toMatchObject({ nickname: 'LOJA TESTE ML', mlUserId: String(sellerId), status: 'active' });
    expect(conn.sync).toMatchObject({ status: 'done', progress: 100, phase: 'finishing' });
    expect(conn.sync.ordersImported).toBe(120);
    expect(fake.calls.refresh).toBe(1); // token expirando foi renovado uma única vez

    // esperado pela mesma regra do sistema: "30 dias" = dias inteiros do calendário de São Paulo
    const from = Date.parse(`${resolvePeriod('30d', todayIn()).from}T00:00:00-03:00`);
    const paid30 = fake.orders.filter((o) => o.status === 'paid' && Date.parse(o.date_created) >= from).length;
    expect(paid30).toBeGreaterThan(30);
    const dash = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=30d&fresh=1', cookies })).json();
    expect(dash.kpis.orders).toBe(paid30);
    expect(dash.kpis.revenue).toBe(paid30 * 100);
    // líquido = faturamento - tarifas (12 por pedido) - frete pago pelo vendedor (20 por pedido)
    expect(dash.kpis.net).toBe(paid30 * (100 - 12 - 20));
    expect(dash.missingCosts).toBe(true);
    // Mercado Ads: 30 dias × R$ 10; TACOS = Ads / faturamento; sai do lucro e da margem
    expect(dash.ads).toEqual({ status: 'ok', message: null });
    expect(dash.kpis.adSpend).toBe(300);
    expect(dash.kpis.tacos).toBeCloseTo(300 / (paid30 * 100), 6);
    expect(dash.kpis.profitAfterAds).toBeCloseTo(dash.kpis.grossProfit - 300, 2);
    expect(dash.kpis.marginAfterAds).toBeCloseTo(dash.kpis.margin - dash.kpis.tacos, 6);
    expect(fake.calls.adCost).toBe(90); // 90 dias na primeira sincronização
    // fatura atual: o ciclo vem da fatura do ML
    const inv = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=invoice&fresh=1', cookies })).json();
    expect(inv.range.from).toBe(`${todayIn().slice(0, 7)}-01`);
    expect(inv.invoiceLabel).toMatch(/^Fatura 01\/\d\d a 28\/\d\d$/);

    // cadastro de SKUs já mostra todos os SKUs (anúncios + vendas) sem custo
    const skus = (await app.inject({ method: 'GET', url: '/api/v1/skus', cookies })).json();
    expect(skus.counts).toEqual({ all: 5, done: 0, missing: 5 });
    expect(skus.items[0].pictureUrl).toMatch(/foto-\d\.jpg$/);
    expect(dash.isDemo).toBe(false);
    expect(dash.accounts.map((a: { nickname: string }) => a.nickname)).toEqual(['LOJA TESTE ML']);

    // top 5 com foto do anúncio
    expect(dash.topProducts).toHaveLength(5);
    for (const p of dash.topProducts) expect(p.pictureUrl).toMatch(/^https:\/\/http2\.mlstatic\.com\/foto-\d\.jpg$/);
    // pausados: sem estoque primeiro
    expect(dash.paused.total).toBe(3);
    expect(dash.paused.outOfStock).toBe(2);
    expect(dash.paused.items.map((i: { outOfStock: boolean }) => i.outOfStock)).toEqual([true, true, false]);

    // anúncio reativado no ML → notificação "items" tira ele do carrossel
    fake.catalog.set('MLB9003', { ...fake.catalog.get('MLB9003')!, status: 'active' });
    await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/mercado-livre/notifications',
      payload: { topic: 'items', resource: '/items/MLB9003', user_id: sellerId, application_id: 'app-teste' },
    });
    let pausedTotal = 3;
    for (let i = 0; i < 40 && pausedTotal !== 2; i++) {
      await new Promise((r) => setTimeout(r, 50));
      pausedTotal = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=30d&fresh=1', cookies })).json().paused.total;
    }
    expect(pausedTotal).toBe(2);

    // atualização automática de hora em hora: venda nova (sem notificação) entra no ciclo
    const before7d = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=7d&fresh=1', cookies })).json().kpis.orders;
    fake.orders.push({ ...fake.orders[1]!, id: 9_100_000, status: 'paid', date_created: new Date(Date.now() - 3_600_000).toISOString() });
    const slot = new Date(Date.UTC(2200, 0, 1) + randomInt(0, 1_000_000) * 3_600_000); // horário exclusivo deste teste
    expect(await app.ml!.hourlyTick(slot)).toBe(true);
    expect(await app.ml!.hourlyTick(slot)).toBe(false); // mesma hora não roda duas vezes
    const after7d = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=7d&fresh=1', cookies })).json().kpis.orders;
    expect(after7d).toBe(before7d + 1);
    const st = (await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/status', cookies })).json();
    expect(st.connections[0].sync.status).toBe('done'); // card de progresso segue mostrando a completa
    expect(Date.parse(st.connections[0].lastSyncedAt)).toBeGreaterThan(Date.now() - 60_000);

    // reimportar não duplica
    await app.inject({ method: 'POST', url: '/api/v1/integrations/mercado-livre/sync', cookies, payload: {} });
    await app.ml!.whenIdle();
    const again = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=30d&fresh=1', cookies })).json();
    expect(again.kpis.orders).toBe(paid30 + 1); // +1 = venda trazida pela atualização automática acima

    // notificação de venda nova chega em tempo real
    const notif = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/mercado-livre/notifications',
      payload: { topic: 'orders_v2', resource: '/orders/5550001', user_id: sellerId, application_id: 'app-teste' },
    });
    expect(notif.statusCode).toBe(200);
    let today = 0;
    for (let i = 0; i < 40 && today < 555; i++) {
      await new Promise((r) => setTimeout(r, 50));
      today = (await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=today&fresh=1', cookies })).json().kpis.revenue;
    }
    expect(today).toBeGreaterThanOrEqual(555);

    // ---- Preço riscado e bônus de tarifa vêm da sincronização (salvos no banco)
    // (MLB9003 foi reativado pela notificação acima e reimportado com a promoção)
    const active = (await app.inject({ method: 'GET', url: '/api/v1/listings?status=active&q=MLB9003', cookies })).json();
    expect(active.items[0]).toMatchObject({ id: 'MLB9003', price: 70, originalPrice: 100, feeBonus: 10, promoName: 'Aumente suas vendas' });
    const semPromo = (await app.inject({ method: 'GET', url: '/api/v1/listings?status=paused&q=MLB9001', cookies })).json();
    expect(semPromo.items[0]).toMatchObject({ originalPrice: null, feeBonus: null });

    // ---- Central de Promoção: só campanhas abertas; candidatos enriquecidos pelo banco local
    const promos = (await app.inject({ method: 'GET', url: '/api/v1/listings/promotions', cookies })).json();
    expect(promos.items.map((p: { id: string }) => p.id)).toEqual(['P-DEAL']);
    const promo = promos.items[0];
    expect(promo).toMatchObject({ requiresPrice: true, account: 'LOJA TESTE ML' });
    const candUrl = `/api/v1/listings/promotions/${promo.connectionId}/P-DEAL/candidates?type=DEAL`;
    const cands = (await app.inject({ method: 'GET', url: candUrl, cookies })).json();
    expect(cands.total).toBe(3);
    expect(cands.items[0]).toMatchObject({ id: 'MLB0', sku: 'SKU-0', title: 'Peça 0', minPrice: 80, suggestedPrice: 90 });
    const sem = await app.inject({
      method: 'POST',
      url: `/api/v1/listings/promotions/${promo.connectionId}/P-DEAL/items/MLB0`,
      cookies,
      payload: { promotionType: 'DEAL' },
    });
    expect(sem.statusCode).toBe(400); // campanha com preço exige preço de oferta
    const ok = await app.inject({
      method: 'POST',
      url: `/api/v1/listings/promotions/${promo.connectionId}/P-DEAL/items/MLB0`,
      cookies,
      payload: { promotionType: 'DEAL', dealPrice: 88 },
    });
    expect(ok.statusCode).toBe(200);
    // inscrever invalida o cache: a lista já vem sem o anúncio
    const after = (await app.inject({ method: 'GET', url: candUrl, cookies })).json();
    expect(after.items.map((c: { id: string }) => c.id)).toEqual(['MLB1', 'MLB2']);
    // ---- Editor: descrição e atacado B2B (confere a aplicação relendo o preço B2B)
    const ed = (await app.inject({ method: 'GET', url: '/api/v1/listings/MLB1/editor', cookies })).json();
    expect(ed).toMatchObject({ description: 'Descrição atual', dimensions: { width: '10' }, pictures: [{ id: 'P1' }] });
    expect(ed.attributes.some((a: { id: string }) => a.id.startsWith('SELLER_PACKAGE_'))).toBe(false);
    const d = await app.inject({ method: 'PUT', url: '/api/v1/listings/MLB1/description', cookies, payload: { text: 'Nova' } });
    expect(d.statusCode).toBe(200);
    expect(fake.calls.desc).toBe('Nova');
    const w = await app.inject({
      method: 'PUT',
      url: '/api/v1/listings/MLB1/wholesale',
      cookies,
      payload: { tiers: [{ minUnits: 10, price: 85 }, { minUnits: 5, price: 92 }] },
    });
    expect(w.json()).toEqual({ ok: true, tiers: 2 });
    const ws = (await app.inject({ method: 'GET', url: '/api/v1/listings/MLB1/wholesale', cookies })).json();
    expect(ws).toMatchObject({ standardPrice: 100, active: true, sample: [{ quantity: 1, price: 100 }, { quantity: 5, price: 92 }, { quantity: 10, price: 85 }, { quantity: 25, price: 85 }] });

    // ---- Duplicar: novo anúncio nasce pausado, sem SKU/EAN copiados, com a descrição
    const dup = await app.inject({ method: 'POST', url: '/api/v1/listings/MLB1/duplicate', cookies, payload: { categoryId: 'MLB999' } });
    expect(dup.json()).toMatchObject({ id: 'MLBDUP', status: 'paused' });
    expect(fake.calls.created).toMatchObject({ category_id: 'MLB999', title: 'Peça 1' });
    expect((fake.calls.created!.attributes as { id: string }[]).some((a) => a.id === 'SELLER_SKU')).toBe(false);
    expect(fake.catalog.get('MLBDUP')!.status).toBe('paused');
    const cats = (await app.inject({ method: 'GET', url: '/api/v1/listings/MLB1/categories?q=viseira', cookies })).json();
    expect(cats).toEqual([{ id: 'MLB999', name: 'Viseiras', domain: 'Capacetes' }]);
    // vendas por mês e margem por venda vêm do banco
    const months = (await app.inject({ method: 'GET', url: '/api/v1/listings/MLB1/sales/monthly', cookies })).json();
    expect(months.length).toBeGreaterThan(0);
    expect(months[0]).toMatchObject({ month: expect.stringMatching(/^\d{4}-\d{2}$/) });
    const sale = (await app.inject({ method: 'GET', url: '/api/v1/listings/MLB1/sales?limit=1', cookies })).json().items[0];
    expect(sale).toMatchObject({ fee: 12 });

    // ---- Precificador: tarifas por tipo e simulação salva (margem recalculada no servidor)
    const quote = (await app.inject({ method: 'GET', url: '/api/v1/pricing/quote?price=100', cookies })).json();
    expect(quote.fees).toEqual([
      { type: 'gold_special', label: 'Clássico', fee: 12, feePct: 12, fixedFee: 0 },
      { type: 'gold_pro', label: 'Premium', fee: 17, feePct: 17, fixedFee: 0 },
    ]);
    const saved = await app.inject({
      method: 'POST',
      url: '/api/v1/pricing/simulations',
      cookies,
      payload: { listingId: 'MLB1', title: 'Peça 1', listingType: 'gold_special', price: 100, cost: 40, freight: 10, taxPct: 9, fee: 12 },
    });
    expect(saved.json()).toMatchObject({ margin: 29, marginPct: 0.29 });
    const sims = (await app.inject({ method: 'GET', url: '/api/v1/pricing/simulations', cookies })).json();
    expect(sims[0]).toMatchObject({ listingId: 'MLB1', price: 100, margin: 29 });
    const otherSims = (await app.inject({ method: 'GET', url: '/api/v1/pricing/simulations', cookies: await account() })).json();
    expect(otherSims).toEqual([]); // simulações são da empresa

    // ---- Categorias com % de tarifa (cache global) e frete pelas medidas
    const root = (await app.inject({ method: 'GET', url: '/api/v1/pricing/category-tree', cookies })).json();
    expect(root.items).toEqual([
      { id: 'MLB1747', name: 'Acessórios para Veículos', leaf: false, feeClassic: 12, feePremium: 17 },
      { id: 'MLB1000', name: 'Eletrônicos', leaf: true, feeClassic: 12, feePremium: 17 },
    ]);
    const child = (await app.inject({ method: 'GET', url: '/api/v1/pricing/category-tree?parent=MLB1747', cookies })).json();
    expect(child.items[0]).toMatchObject({ id: 'MLB8000', leaf: true, feeClassic: 12 });
    const catBefore = fake.calls.catCalls;
    await app.inject({ method: 'GET', url: '/api/v1/pricing/category-tree?parent=MLB1747', cookies });
    expect(fake.calls.catCalls - catBefore).toBe(1); // só a categoria-mãe; as filhas vêm do cache
    const info = (await app.inject({ method: 'GET', url: '/api/v1/pricing/categories/MLB8000', cookies })).json();
    expect(info).toMatchObject({ id: 'MLB8000', dims: { height: 12, width: 25, length: 30, weight: 600 } });
    expect(info.path.map((p: { name: string }) => p.name)).toEqual(['Acessórios para Veículos', 'Viseiras']);
    const fr = (await app.inject({ method: 'GET', url: '/api/v1/pricing/freight?price=120&type=gold_special&height=12&width=25&length=30&weight=600', cookies })).json();
    expect(fr).toEqual({ freight: 23.45, freeShipping: true, source: 'ml' });
    expect(fake.calls.lastFreight).toBe('12x25x30,600');
    const cheap = (await app.inject({ method: 'GET', url: '/api/v1/pricing/freight?price=50&type=gold_special&height=12&width=25&length=30&weight=600', cookies })).json();
    expect(cheap).toEqual({ freight: 0, freeShipping: false, source: 'none' });

    // ---- DIFAL da fatura do ML: sincronizado no banco e usado na aba Vendas (1x/dia no mês aberto)
    expect(fake.calls.billing).toBe(1); // a sincronização completa leu a fatura
    const ov = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=this_month', cookies })).json();
    expect(ov.difal.billed).toMatchObject({ total: 70 });
    expect(ov.months[0]).toMatchObject({ difalBilled: 70, difal: 70 });
    const byListing = (await app.inject({ method: 'GET', url: '/api/v1/sales/overview?period=this_month&listingId=MLB1', cookies })).json();
    expect(byListing.difal.billed).toBeNull(); // fatura é da conta, não do anúncio

    // ---- Flex: configuração da conta e ativar no anúncio
    const fx = (await app.inject({ method: 'GET', url: '/api/v1/flex/status', cookies })).json();
    expect(fx.accounts[0]).toMatchObject({
      active: true,
      coverage: { type: 'zone', zones: [{ id: 'Sao_Paulo', label: 'Sao Paulo' }] },
      pricing: [{ fromKg: null, toKg: 0.5, price: 7.99 }, { fromKg: 0.5, toKg: 5, price: 8.99 }],
    });
    const on = await app.inject({ method: 'PUT', url: '/api/v1/listings/MLB2/flex', cookies, payload: { enabled: true } });
    expect(on.json()).toEqual({ id: 'MLB2', flex: true });
    const withFlex = (await app.inject({ method: 'GET', url: '/api/v1/listings?status=active&q=MLB2', cookies })).json();
    expect(withFlex.items[0].flex).toBe(true);

    // ---- Oportunidades de Flex: vendas com entrega dentro da zona (polígono) e anúncio ainda sem Flex
    const tid = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies })).json().tenant.id as string;
    const dbx = new Database(TEST_DB!);
    await dbx.withTenant(tid, async (c) => {
      // MLB0: vendas em SP (dentro); MLB3: em Campinas (fora); MLB2 já tem Flex
      await c.query(`UPDATE orders o SET ship_lat = -23.55, ship_lng = -46.63 FROM order_items i WHERE i.order_id = o.id AND i.listing_id IN ('MLB0', 'MLB2')`);
      await c.query(`UPDATE orders o SET ship_lat = -22.90, ship_lng = -47.06 FROM order_items i WHERE i.order_id = o.id AND i.listing_id = 'MLB3'`);
    });
    await dbx.close();
    const opp = (await app.inject({ method: 'GET', url: '/api/v1/flex/opportunities', cookies })).json();
    expect(opp).toMatchObject({ method: 'zones', areaLabel: 'Sao Paulo' });
    expect(opp.items.map((x: { id: string }) => x.id)).toEqual(['MLB0']);
    expect(opp.items[0].shareInArea).toBe(1);

    // outra empresa não usa a conexão desta
    const other = await account();
    const cross = await app.inject({ method: 'GET', url: candUrl, cookies: other });
    expect(cross.statusCode).toBe(404);
  });

  it('recusa state reutilizado, código inválido, negação e conta já usada por outra empresa', async () => {
    const cookies = await account();
    const state = await stateOf(cookies);
    const bad = await app.inject({ method: 'GET', url: `/api/v1/integrations/mercado-livre/callback?code=codigo-ruim&state=${state}` });
    expect(bad.headers.location).toBe('/?ml=error&reason=exchange');
    const reuse = await app.inject({ method: 'GET', url: `/api/v1/integrations/mercado-livre/callback?code=codigo-bom&state=${state}` });
    expect(reuse.headers.location).toBe('/?ml=error&reason=state');
    const denied = await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/callback?error=access_denied' });
    expect(denied.headers.location).toBe('/?ml=error&reason=denied');

    // mesmo vendedor do teste anterior tentando entrar em outra empresa
    const taken = await app.inject({
      method: 'GET',
      url: `/api/v1/integrations/mercado-livre/callback?code=codigo-bom&state=${await stateOf(cookies)}`,
    });
    expect(taken.headers.location).toBe('/?ml=error&reason=taken');
  });

  it('notificações repetidas em sequência viram uma só consulta ao ML; corpo inválido é ignorado', async () => {
    const send = (payload: object) =>
      app.inject({ method: 'POST', url: '/api/v1/integrations/mercado-livre/notifications', payload });
    const n = { topic: 'orders_v2', resource: '/orders/5557777', user_id: sellerId, application_id: 'app-teste' };
    const rs = await Promise.all(Array.from({ length: 8 }, () => send(n)));
    expect(rs.every((r) => r.statusCode === 200)).toBe(true);
    expect((await send({ topic: 'orders_v2', resource: "'; drop table x", user_id: 'abc' })).statusCode).toBe(200);
    await app.ml!.whenIdle();
    expect(fake.calls.orderFetch['5557777']).toBe(1);
  });

  it('dois pedidos de sincronização ao mesmo tempo abrem uma só', async () => {
    const cookies = await account();
    const state = await stateOf(cookies);
    // conta nova do mesmo vendedor não pode (já é de outra empresa): usa a conexão da 1ª empresa via status
    expect(state).toBeTruthy();
    const svc = app.ml!;
    const tenant = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: firstCookies })).json().tenant.id as string;
    const conn = (await svc.status(tenant)).connections[0]!;
    await svc.whenIdle();
    const db = new Database(TEST_DB!);
    const count = async () =>
      (await db.withTenant(tenant, (c) => c.query("SELECT count(*)::int AS n FROM ml_sync_runs WHERE connection_id = $1 AND kind = 'full'", [conn.id]))).rows[0].n as number;
    const before = await count();
    await Promise.all([svc.startSync(tenant, conn.id), svc.startSync(tenant, conn.id), svc.startSync(tenant, conn.id)]);
    const after = await count();
    await svc.whenIdle();
    await db.close();
    expect(after - before).toBe(1);
  });

  it('ignora notificações de outro aplicativo e exige login para conectar', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/v1/integrations/mercado-livre/notifications',
      payload: { topic: 'orders_v2', resource: '/orders/1', user_id: sellerId, application_id: 'outro-app' },
    });
    expect(res.statusCode).toBe(200);
    expect((await app.inject('/api/v1/integrations/mercado-livre/connect')).statusCode).toBe(401);
  });
});

describe.skipIf(!TEST_DB)('Central de Devoluções (pós-venda do ML)', () => {
  let app: FastifyInstance;
  // conta ML própria: a mesma conta não pode estar em duas empresas
  const fake = fakeMl(randomInt(1_000_000, 9_999_999));
  const account = async () => {
    const cnpj = randomCnpj();
    const email = `dev2-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const res = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    return { nvs_session: res.cookies.find((c) => c.name === 'nvs_session')!.value };
  };
  const stateOf = async (cookies: Record<string, string>) =>
    new URL((await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/connect', cookies })).json().url).searchParams.get('state')!;
  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        ML_CLIENT_ID: 'app-teste',
        ML_CLIENT_SECRET: 'segredo-teste',
        ML_REDIRECT_URI: 'https://exemplo.test/api/v1/integrations/mercado-livre/callback',
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }),
      mlApi: fake.api,
    });
  });
  afterAll(() => app.close());

  it('Central de Devoluções: sincroniza do ML, bipa, confere, contesta com foto e mostra no B.I', async () => {
    // empresa nova com equipe (Ana na Análise) e a conta do ML conectada
    const cnpj = randomCnpj();
    const email = `dev-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj, team: [{ name: 'Ana', area: 'ambos', master: true }] } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const base = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = login.json().tenant.id as string;
    const team = (await app.inject({ method: 'GET', url: '/api/v1/team', cookies: base })).json();
    const pin = await app.inject({ method: 'POST', url: '/api/v1/team/login', cookies: base, payload: { operatorId: team.members[0].id, pin: '1234', mode: 'operacao' } });
    const cookies = { ...base, nvs_person: pin.cookies.find((c) => c.name === 'nvs_person')!.value };
    const state = await stateOf(base);
    await app.inject({ method: 'GET', url: `/api/v1/integrations/mercado-livre/callback?code=codigo-bom&state=${state}` });
    await app.ml!.whenIdle();
    const call = (method: 'GET' | 'POST', url: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${url}`, cookies, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

    // sem a pessoa (PIN) não entra
    expect((await app.inject({ method: 'GET', url: '/api/v1/returns/summary', cookies: base })).statusCode).toBe(401);

    expect(await app.returnsSync!.syncTenant(tenantId, { days: 30, allOpen: true })).toEqual({ claims: 1, saved: 1, failures: 0 });
    const summary = (await call('GET', '/returns/summary')).json();
    expect(summary).toMatchObject({ connected: true, counts: { aguardando_conferencia: 1 }, attention: { awaitingCheck: 1, deadline24h: 0 } });
    expect(summary.lastSync).toBeTruthy();

    // bipe pelo QR da etiqueta (JSON com o nº do envio)
    const byQr = (await call('POST', '/returns/find', { code: '{"id":"43215678901","t":"lm"}' })).json();
    expect(byQr.matches).toHaveLength(1);
    const ret = byQr.matches[0].row;
    expect(ret).toMatchObject({
      externalId: '5001', orderId: '9000001', packId: '2000009', reason: 'defeito', responsible: 'vendedor', platformCost: 25,
      status: 'aguardando_conferencia', canDispute: true, awaitingReview: true, items: [{ sku: 'SKU-1', name: 'Peça 1', qty: 1 }],
    });
    // código desconhecido: pergunta ao ML de que pedido é o envio e aprende (o 2º bipe não consulta de novo)
    expect((await call('POST', '/returns/find', { code: '123456789012' })).json().matches).toHaveLength(1);
    expect((await call('POST', '/returns/find', { code: '123456789012' })).json().matches).toHaveLength(1);
    expect(fake.post.shipmentLookups).toBe(1);
    expect((await call('POST', '/returns/find', { code: 'NADA-A-VER-999' })).json().matches).toEqual([]);

    // conferência: produto nosso, mas sem condição de venda → B (avaria), vale contestar
    const checked = (await call('POST', `/returns/${ret.id}/check`, { productCorrect: true, complete: true, unused: false, resellable: false, note: 'Lateral quebrada' })).json();
    expect(checked.row.check).toMatchObject({ class: 'B', dispute: true, manualTicket: false, reverseFreight: 25, checkedBy: 'Ana', stockMoves: [{ sku: 'vendido', deposit: 'avaria', type: 'E' }] });
    expect(checked.row).toMatchObject({ status: 'precisa_acao', pending: ['lancar_estoque', 'contestar'] });

    // contestar exige foto; motivo tem que ser o oficial do ML
    expect((await call('POST', `/returns/${ret.id}/dispute`, { reason: 'SRF2', message: 'Produto voltou com a lateral quebrada.' })).statusCode).toBe(400);
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
    expect((await call('POST', `/returns/${ret.id}/evidence`, { mime: 'image/png', dataBase64: Buffer.from('MZ-exe').toString('base64') })).statusCode).toBe(400);
    const ev = (await call('POST', `/returns/${ret.id}/evidence`, { mime: 'image/png', dataBase64: png.toString('base64') })).json();
    expect(ev).toHaveLength(1);
    expect((await call('GET', `/returns/evidence/${ev[0].id}`)).rawPayload.equals(png)).toBe(true);
    expect((await call('POST', `/returns/${ret.id}/dispute`, { reason: 'XX', message: 'Produto voltou com a lateral quebrada.' })).statusCode).toBe(400);
    const disputed = (await call('POST', `/returns/${ret.id}/dispute`, { reason: 'SRF2', message: 'Produto voltou com a lateral quebrada.' })).json();
    expect(disputed.disputes[0]).toMatchObject({ ok: true, path: 'revisao_com_falha', sentBy: 'Ana' });
    expect(fake.post.posts.at(-1)).toEqual({ path: '/post-purchase/v1/returns/R1/return-review', body: [{ reason: 'SRF2', message: 'Produto voltou com a lateral quebrada.', attachments: ['anexo-1.jpg'] }] });
    expect(disputed.evidence).toEqual([]); // o ML já recebeu as fotos
    expect(disputed.row.pending).toEqual(['lancar_estoque']);
    // depois de contestada a conferência não muda mais; estoque ajustado → em mediação
    expect((await call('POST', `/returns/${ret.id}/check`, { productCorrect: true, complete: true, unused: true, resellable: true })).statusCode).toBe(409);
    expect((await call('POST', `/returns/${ret.id}/stock-done`)).json().row).toMatchObject({ status: 'em_mediacao', pending: [] });
    expect((await call('POST', `/returns/${ret.id}/accept`)).statusCode).toBe(409);

    // lista e B.I
    const list = (await call('GET', '/returns?status=em_mediacao')).json();
    expect(list).toMatchObject({ total: 1, counts: { em_mediacao: 1 } });
    expect(list.items[0].items[0].pictureUrl).toBe('https://http2.mlstatic.com/foto-1.jpg');
    const bi = (await call('GET', '/returns/bi?days=30')).json();
    expect(bi).toMatchObject({ total: 1, classes: { B: 1 }, reasons: [{ reason: 'defeito', qty: 1, pct: 100 }] });
    expect(bi.money).toMatchObject({ reverseFreight: 25, productLoss: 0, withoutCost: 1, totalCost: 25 }); // SKU-1 sem custo cadastrado
    expect(bi.products[0]).toMatchObject({ sku: 'SKU-1', qty: 1 });

    // outra empresa não vê nada
    const other = await account();
    expect((await app.inject({ method: 'GET', url: `/api/v1/returns/${ret.id}`, cookies: other })).statusCode).toBe(401); // sem PIN
  });
});

describe.skipIf(!TEST_DB)('Central de Devoluções — contrato das telas originais (/central)', () => {
  let app: FastifyInstance;
  const fake = fakeMl(randomInt(1_000_000, 9_999_999));
  beforeAll(async () => {
    app = await buildApp({
      env: loadEnv({
        ...process.env,
        DATABASE_URL: TEST_DB,
        AUTH_RATE_LIMIT_MAX: '1000',
        ML_CLIENT_ID: 'app-teste',
        ML_CLIENT_SECRET: 'segredo-teste',
        ML_REDIRECT_URI: 'https://exemplo.test/api/v1/integrations/mercado-livre/callback',
        TOKEN_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      }),
      mlApi: fake.api,
    });
  });
  afterAll(() => app.close());

  /** multipart com o arquivo no campo "arquivo", como o navegador manda. */
  const multipart = (type: string, bytes: Buffer) => {
    const b = 'limite-teste';
    const payload = Buffer.concat([
      Buffer.from(`--${b}\r\nContent-Disposition: form-data; name="arquivo"; filename="x"\r\nContent-Type: ${type}\r\n\r\n`),
      bytes,
      Buffer.from(`\r\n--${b}--\r\n`),
    ]);
    return { payload, headers: { 'content-type': `multipart/form-data; boundary=${b}` } };
  };
  const NAIVE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/;

  it('opera a Central no formato do NOVAES-ESTOQUE: bipe, conferência, provas, contestação, estoque, B.I, custos e Retorno Full', async () => {
    const cnpj = randomCnpj();
    const email = `central-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj, team: [{ name: 'Ana', area: 'ambos', master: true }] } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const base = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const tenantId = login.json().tenant.id as string;
    const team = (await app.inject({ method: 'GET', url: '/api/v1/team', cookies: base })).json();
    const pin = await app.inject({ method: 'POST', url: '/api/v1/team/login', cookies: base, payload: { operatorId: team.members[0].id, pin: '1234', mode: 'operacao' } });
    const cookies = { ...base, nvs_person: pin.cookies.find((c) => c.name === 'nvs_person')!.value };
    const state = new URL((await app.inject({ method: 'GET', url: '/api/v1/integrations/mercado-livre/connect', cookies: base })).json().url).searchParams.get('state')!;
    await app.inject({ method: 'GET', url: `/api/v1/integrations/mercado-livre/callback?code=codigo-bom&state=${state}` });
    await app.ml!.whenIdle();
    // o "Sincronizar agora" do Dashboard também traz as devoluções
    expect((await app.inject({ method: 'POST', url: '/api/v1/integrations/mercado-livre/sync', cookies: base, payload: {} })).statusCode).toBe(202);
    await app.ml!.whenIdle();
    for (let t = 0; t < 100 && (app.returnsSync!.isRunning(tenantId) || !app.returnsSync!.progress.get(tenantId).terminada_em); t++) await new Promise((r) => setTimeout(r, 100));
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, c: Record<string, string> = cookies) =>
      app.inject({ method, url: `/api/v1/central${url}`, cookies: c, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

    // operação: só o que volta para a empresa (destino vendedor), com contagens, a caminho por plataforma e prejuízo
    const op = (await call('GET', '/operacao')).json();
    expect(op).toMatchObject({ total: 1, contagens: { aguardando_conferencia: 1 }, a_caminho: { mercado_livre: { postado: 0 }, shopee: { postado: 0 } } });
    expect(op.itens[0]).toMatchObject({
      plataforma: 'mercado_livre', id_externo: '5001', pedido: '9000001', pacote: '2000009', motivo: 'defeito', responsavel: 'vendedor',
      custo_plataforma: 25, prejuizo: 25, produto: 'Peça 1', imagem: 'https://http2.mlstatic.com/foto-1.jpg', status: 'aguardando_conferencia',
      pendencias: [], conferencia: null, itens: [{ item_id: 'MLB1', sku: 'SKU-1', quantidade: 1, nome: 'Peça 1' }],
    });
    expect(op.itens[0].aberta_em).toMatch(NAIVE); // UTC sem fuso: a tela acrescenta o "Z"
    expect(op.itens[0].prazo_vendedor).toMatch(NAIVE);
    expect((await call('GET', '/operacao/atencao')).json()).toEqual({ contestar: 0, chamados_manuais: 0, lancar_estoque: 0, aguardando_conferencia: 1, prazo_em_24h: 0 });
    expect((await call('GET', '/operacao/ultimas?limite=5')).json()[0]).toMatchObject({ id_externo: '5001', status: 'aguardando_conferencia' });

    // bipe pelo QR da etiqueta: a tela da conferência (Olist não conectada aparece como aviso)
    const telas = (await call('GET', `/conferencia/${encodeURIComponent('{"id":"43215678901","t":"lm"}')}`)).json();
    expect(telas).toHaveLength(1);
    expect(telas[0]).toMatchObject({
      devolucao: { id_externo: '5001', aguarda_revisao: true, pode_contestar: true }, conferencia: null, evidencias: [],
      midia: { anuncio: [{ nome: 'Peça 1', imagem: 'https://http2.mlstatic.com/foto-1.jpg' }], link: 'https://www.mercadolivre.com.br/vendas/2000009/detalhe' },
      olist: { pedidos: [] },
    });
    expect(telas[0].olist.erro).toBeTruthy();
    const id = telas[0].devolucao.id as string;
    expect((await call('GET', '/conferencia/NADA-A-VER-999')).json()).toEqual([]);

    // conferência: precisa da pessoa (PIN); avariado → B, contestar
    const constatacao = { produto_correto: true, completo: true, sem_uso: false, revendavel: false, observacao: 'Lateral quebrada' };
    expect((await call('POST', `/conferencia/${id}`, constatacao, base)).statusCode).toBe(401);
    expect((await call('POST', `/conferencia/${id}`, { ...constatacao, revendavel: 'não' })).statusCode).toBe(400);
    const decisao = (await call('POST', `/conferencia/${id}`, constatacao)).json();
    expect(decisao).toMatchObject({
      classe: 'B', contestar: true, chamado_manual: false, lancamentos: [{ sku: 'vendido', deposito: 'avaria', tipo: 'E' }],
      evidencias_exigidas: ['foto'], frete_reverso: 25, perda_produto: null, plataforma: 'mercado_livre', pedido: '9000001',
    });
    const tela = (await call('GET', '/conferencia/9000001')).json()[0];
    expect(tela.conferencia).toMatchObject({ classe: 'B', revendavel: false, observacao: 'Lateral quebrada', estoque_lancado_em: null, evidencias_exigidas: ['foto'] });
    expect(tela.conferencia.conferida_em).toMatch(NAIVE);

    // provas: foto e vídeo em multipart; tipo desconhecido é recusado
    const png = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]);
    const up = (type: string, bytes: Buffer) => app.inject({ method: 'POST', url: `/api/v1/central/conferencia/${id}/evidencias`, cookies, ...multipart(type, bytes) });
    expect((await up('application/x-msdownload', Buffer.from('MZ'))).statusCode).toBe(400);
    const foto = (await up('image/png', png)).json();
    expect(foto).toMatchObject({ devolucao_id: id, tipo: 'foto', tamanho: png.length });
    expect((await up('video/mp4', Buffer.alloc(64, 1))).json()).toMatchObject({ tipo: 'video' });
    expect((await call('GET', `/conferencia/evidencias/${foto.id}`)).rawPayload.equals(png)).toBe(true);

    // contestação: motivos oficiais do ML; só a foto vai pela API, com aviso do vídeo
    expect((await call('GET', `/mediacoes/${id}/motivos`)).json()).toEqual([{ id: 'SRF2', texto: 'O produto chegou com defeito' }]);
    expect((await call('POST', `/mediacoes/${id}/contestar`, { motivo: 'SRF2', texto: 'curto' })).statusCode).toBe(400);
    const uploadsAntes = fake.post.uploads;
    const contestacao = (await call('POST', `/mediacoes/${id}/contestar`, { motivo: 'SRF2', texto: 'Produto voltou com a lateral quebrada.' })).json();
    expect(contestacao).toMatchObject({ ok: true, caminho: 'revisao_com_falha', motivo: 'SRF2', erro: null });
    expect(contestacao.aviso).toMatch(/Vídeos/);
    expect(fake.post.uploads - uploadsAntes).toBe(1);
    expect((await call('GET', `/mediacoes/${id}`)).json()).toHaveLength(1);
    expect((await call('POST', `/mediacoes/${id}/aceitar`)).statusCode).toBe(409);

    // estoque: um clique só
    const lancado = (await call('POST', `/conferencia/${id}/lancar-estoque`, { via_olist: false })).json();
    // sem ERP: avaria vai para o estoque virtual do sistema
    expect(lancado).toEqual([expect.objectContaining({ sku: 'vendido', deposito: 'avaria', tipo: 'E', ok: true, quantidade: 1, destino: 'Estoque virtual · avaria SKU-1 (saldo 1)' })]);
    expect((await call('POST', `/conferencia/${id}/lancar-estoque`, {})).statusCode).toBe(409);

    // estoque virtual: a avaria aparece com saldo; "consertou" volta para o anúncio próprio no ML
    expect((await call('GET', '/estoque-virtual')).json()).toMatchObject({
      total: { avaria: 1, vendavel: 0 }, skus: [{ sku: 'SKU-1', avaria: 1, vendavel: 0, nome: 'Peça 1' }],
      movimentos: [{ sku: 'SKU-1', deposito: 'avaria', quantidade: 1, origem: 'devolucao', operador: 'Ana' }],
    });
    expect((await call('POST', '/estoque-virtual/ajuste', { sku: 'SKU-1', deposito: 'avaria', quantidade: -5, motivo: 'descarte' })).statusCode).toBe(400);
    expect((await call('POST', '/estoque-virtual/ajuste', { sku: 'SKU-1', deposito: 'avaria', para: 'vendavel', quantidade: 1, motivo: 'Consertado' })).json())
      .toEqual({ sku: 'SKU-1', destino: 'Mercado Livre MLB1 (estoque 3 → 4)', vendavel: 0, avaria: 0 });
    expect((await call('GET', '/estoque-virtual')).json()).toMatchObject({ skus: [], total: { avaria: 0 } });
    expect((await call('GET', '/operacao?status=em_mediacao')).json()).toMatchObject({ total: 1, contagens: { em_mediacao: 1 } });

    // operadores: quem conferiu hoje
    const atv = (await call('GET', '/operadores/atividade')).json();
    expect(atv).toMatchObject({ total: 1, por_operador: { Ana: { total: 1, por_plataforma: { mercado_livre: 1 } } } });
    expect(atv.itens[0]).toMatchObject({ operador: 'Ana', classe: 'B', contestar: true, status: 'em_mediacao', pedido: '9000001' });
    expect((await call('GET', '/operadores/atividade?dia=2099-01-01')).statusCode).toBe(400);

    // B.I: dinheiro, quebrados, Full x orgânica (consultado no envio de ida)
    const bi = (await call('GET', '/bi/resumo?dias=30')).json();
    expect(bi).toMatchObject({
      total: 1, dias: 30, status: { em_mediacao: 1 }, motivos: [{ motivo: 'defeito', quantidade: 1, pct: 100 }],
      dinheiro: { frete_reverso: 25, frete_cobrado: 25, perda_bancada: 0, sem_custo: 1, custo_total: 25 },
      quebrados: { por_origem: { bancada: { quantidade: 1, sem_custo: 1 } } },
      logistica_total: { mercado_livre: { full: 1, organica: 0, sem_info: 0 } },
      produtos: { mercado_livre: [{ sku: 'SKU-1', quantidade: 1, pct: 100, imagem: 'https://http2.mlstatic.com/foto-1.jpg' }], shopee: [] },
      por_plataforma: { mercado_livre: { devolucoes: 1 } },
    });
    expect(bi.serie).toHaveLength(30);
    expect((await call('GET', '/bi/resumo?fatura=2026-13-01')).statusCode).toBe(400);
    expect((await call('GET', '/bi/mensal')).json().meses).toHaveLength(3);

    // quebrados: sem custo → cadastra o custo valendo desde hoje e a conferência é recalculada
    expect((await call('GET', '/produtos-quebrados?dias=30')).json()).toMatchObject({ produtos: [{ sku: 'SKU-1', quantidade: 1, sem_custo: 1, valor: 0 }], total: { quantidade: 1 } });
    const hoje = todayIn();
    expect((await call('POST', '/custos/SKU-1', { custo: 0, desde: hoje })).statusCode).toBe(400);
    expect((await call('POST', '/custos/SKU-1', { custo: 40, desde: '2000-01-02' })).json()).toEqual({ sku: 'SKU-1', custo_atual: 40, conferencias_recalculadas: 1 });
    expect((await call('GET', '/produtos-quebrados?dias=30')).json().produtos[0]).toMatchObject({ valor: 40, sem_custo: 0, custo_atual: 40 });
    expect((await call('GET', '/custos/SKU-1/historico')).json()[0]).toMatchObject({ custo: 40, vigente_desde: '2000-01-02', registrado_por: 'Ana' });
    expect((await call('GET', '/bi/resumo?dias=30')).json().dinheiro).toMatchObject({ perda_bancada: 40, custo_total: 65 });

    // respostas prontas
    const rp = (await call('POST', '/respostas-prontas', { texto: '  Caixa amassada  ' })).json();
    expect(rp).toMatchObject({ texto: 'Caixa amassada' });
    expect((await call('PUT', `/respostas-prontas/${rp.id}`, { texto: 'Caixa rasgada' })).json()).toEqual({ id: rp.id, texto: 'Caixa rasgada' });
    expect((await call('POST', '/respostas-prontas', { texto: ' ' })).statusCode).toBe(400);
    expect((await call('GET', '/respostas-prontas')).json()).toEqual([{ id: rp.id, texto: 'Caixa rasgada' }]);
    await call('DELETE', `/respostas-prontas/${rp.id}`);
    expect((await call('GET', '/respostas-prontas')).json()).toEqual([]);

    // Retorno do Full: etiqueta do Full → SKU pelo Master Data
    const db = new Database(TEST_DB!);
    await db.withTenant(tenantId, (c) => c.query(`INSERT INTO wms_barcodes (tenant_id, barcode, sku) VALUES ($1, 'ABCD12345', 'SKU-1')`, [tenantId]));
    await db.close();
    expect((await call('GET', '/retirada-full/XX1')).statusCode).toBe(400);
    expect((await call('GET', '/retirada-full/ZZZZ99999')).statusCode).toBe(404);
    expect((await call('GET', '/retirada-full/abcd12345')).json()).toMatchObject({ codigo: 'ABCD12345', sku: 'SKU-1', item_id: 'MLB1', custo: 40 });
    expect((await call('POST', '/retirada-full/ABCD12345/entrada', { quantidade: 0 })).statusCode).toBe(400);
    // o que volta do Full soma no estoque do anúncio orgânico no ML
    expect((await call('POST', '/retirada-full/ABCD12345/entrada', { quantidade: 2 })).json()).toMatchObject({
      quantidade: 2, lancados: [{ sku: 'SKU-1', quantidade: 2, destino: 'Mercado Livre MLB1 (estoque 3 → 5)' }],
    });
    expect(fake.post.posts.at(-1)).toEqual({ path: '/items/MLB1', body: { available_quantity: 5 } });
    const full = (await call('GET', '/retiradas-full?dias=30')).json();
    expect(full.total).toEqual({ quantidade: 2, bipes: 1, valor: 80, skus: 1 });
    expect(full.bipes[0]).toMatchObject({ operador: 'Ana', codigo: 'ABCD12345' });

    // sincronização: ML conectado, Shopee não integrada; barra parada em 100%
    expect((await call('GET', '/sincronizacao')).json()).toMatchObject({ mercado_livre: { ok: true }, logistica_venda: { ok: true }, shopee: { ok: false } });
    // relatório da leitura: o que o ML respondeu, para conferir com o painel de Pós-venda
    const rel = (await call('GET', '/sincronizacao')).json().mercado_livre.resultado.relatorio;
    expect(rel.buscas).toEqual([
      expect.objectContaining({ status: 'opened', filtro: 'todas', total: 1, lidas: 1, erro: null }),
      expect.objectContaining({ status: 'closed', total: 0, erro: null }),
    ]);
    expect(rel).toMatchObject({ comDevolucao: { delivered: 1 }, semDevolucao: {}, falhas: [], gravadas: 1 });
    expect(rel.sondagens.length).toBeGreaterThan(3);
    expect((await call('GET', '/sincronizacao/progresso')).json()).toMatchObject({ rodando: false, percentual: 100, pendentes: { mediacao_origem: 0, mediacao_atuacao: 0 } });
    expect((await call('GET', '/triagens-full')).json()).toEqual([]);

    // outra empresa não vê nada
    const cnpj2 = randomCnpj();
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email: `central2-${cnpj2}@teste.dev`, phone: '11912345678', cnpj: cnpj2 } });
    const l2 = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email: `central2-${cnpj2}@teste.dev`, password: cnpj2 } });
    const other = { nvs_session: l2.cookies.find((c) => c.name === 'nvs_session')!.value };
    expect((await call('GET', '/operacao', undefined, other)).json()).toMatchObject({ total: 0, itens: [] });
    expect((await call('GET', '/conferencia/9000001', undefined, other)).json()).toEqual([]);
  });
});
