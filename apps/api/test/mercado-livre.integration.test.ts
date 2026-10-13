import { randomBytes, randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
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
  const calls = { refresh: 0, exchange: 0, verifier: '' as string | null, desc: '', created: null as Record<string, unknown> | null };
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
  catalog.set('MLB9003', { id: 'MLB9003', title: 'Pausado com estoque', status: 'paused', sub_status: [], available_quantity: 7, price: 70 });
  const api: MlApi = {
    async updateItem(_t, id, body) {
      const it = catalog.get(id)!;
      if (body.status) it.status = String(body.status);
      return it;
    },
    async listingFees() {
      return [];
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
      return ids.map((id) => catalog.get(id)).filter((i): i is MlItem => Boolean(i));
    },
  };
  return { api, calls, orders, catalog };
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

  it('conecta, sincroniza em etapas, renova o token e preenche o dashboard', async () => {
    const cookies = await account();
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
    expect(conn.sync).toMatchObject({ status: 'done', progress: 100, phase: 'shipping_costs' });
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
