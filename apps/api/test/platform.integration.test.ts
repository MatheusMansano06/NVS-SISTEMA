import { randomInt } from 'node:crypto';
import { resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { loadEnv } from '../src/config/env.js';
import { buildApp } from '../src/app.js';
import { Database } from '../src/shared/infrastructure/database.js';
import { hashPassword } from '../src/shared/infrastructure/password.js';
import { todayIn } from '../src/modules/sales/domain/period.js';

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

describe.skipIf(!TEST_DB)('Painel Master (dono do NVS Tech)', () => {
  let app: FastifyInstance;
  let db: Database;

  beforeAll(async () => {
    app = await buildApp({ env: loadEnv({ ...process.env, DATABASE_URL: TEST_DB, AUTH_RATE_LIMIT_MAX: '1000' }) });
    db = new Database(TEST_DB!);
  });
  afterAll(async () => {
    await app.close();
    await db.close();
  });

  it('empresas, assinatura com cupom, mensalidade em atraso com aviso, comunicado, senha e suspensão', async () => {
    // empresa cliente
    const cnpj = randomCnpj();
    const email = `cliente-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const tenant = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const me = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: tenant })).json();
    const tenantId = me.tenant.id as string;

    // conta master
    const adminEmail = `master-${cnpj}@nvs.dev`;
    await db.query('INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, $2, $3)', [adminEmail, 'Dono', await hashPassword('senha-master-123')]);
    expect((await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: adminEmail, password: 'errada-1234' } })).statusCode).toBe(401);
    const al = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: adminEmail, password: 'senha-master-123' } });
    expect(al.statusCode).toBe(200);
    const admin = { nvs_admin: al.cookies.find((c) => c.name === 'nvs_admin')!.value };
    const call = (method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object, cookies: Record<string, string> = admin) =>
      app.inject({ method, url: `/api/v1${url}`, cookies, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

    // sessões não se misturam
    expect((await call('GET', '/admin/tenants', undefined, tenant)).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: admin })).statusCode).toBe(401);

    // empresas
    const list = (await call('GET', `/admin/tenants?q=${cnpj}`)).json();
    expect(list).toEqual([expect.objectContaining({ id: tenantId, cnpj, ownerEmail: email, status: 'active', subscription: null })]);
    const detail = (await call('GET', `/admin/tenants/${tenantId}`)).json();
    expect(detail.people[0]).toMatchObject({ email, role: 'owner' });

    // plano + cupom 20% por 2 meses → assinatura
    await call('POST', '/admin/plans', { name: `Pro ${cnpj}`, price: 199.9, active: true });
    const plan = (await call('GET', '/admin/plans')).json().find((p: { name: string }) => p.name === `Pro ${cnpj}`);
    const code = `PROMO${cnpj.slice(0, 6)}`;
    expect((await call('POST', '/admin/coupons', { code, kind: 'percent', value: 150, duration: 'once' })).statusCode).toBe(400);
    expect((await call('POST', '/admin/coupons', { code, kind: 'percent', value: 20, duration: 'months', months: 2 })).statusCode).toBe(201);
    expect((await call('PUT', `/admin/tenants/${tenantId}/subscription`, { planId: plan.id, status: 'active', billingDay: 5, couponCode: 'NAOEXISTE' })).statusCode).toBe(400);
    expect((await call('PUT', `/admin/tenants/${tenantId}/subscription`, { planId: plan.id, status: 'active', billingDay: 5, couponCode: code })).statusCode).toBe(204);
    expect((await call('GET', '/admin/coupons')).json().find((c: { code: string }) => c.code === code)).toMatchObject({ redemptions: 1 });

    // mensalidade do mês com desconto; gerar de novo não duplica
    const period = `${todayIn().slice(0, 7)}-01`;
    const gen = (await call('POST', '/admin/invoices/generate', { period })).json();
    expect(gen.created).toBeGreaterThanOrEqual(1);
    let inv = (await call('GET', `/admin/invoices?tenantId=${tenantId}`)).json();
    expect(inv).toEqual([expect.objectContaining({ amount: 199.9, discount: 39.98, total: 159.92, couponCode: code })]);
    expect((await call('POST', '/admin/invoices/generate', { period })).json().created).toBe(0);
    expect((await call('GET', `/admin/tenants/${tenantId}`)).json().subscriptionDetail).toMatchObject({ couponCyclesLeft: 1 });

    // vencida: aviso automático para a empresa e assinatura em atraso
    await db.query(`UPDATE invoices SET due_date = current_date - 3 WHERE tenant_id = $1`, [tenantId]);
    const notices = (await call('GET', '/notices', undefined, tenant)).json();
    expect(notices[0]).toMatchObject({ title: 'Mensalidade em aberto', level: 'danger', automatic: true });
    expect((await call('GET', `/admin/invoices?tenantId=${tenantId}`)).json()[0].situation).toBe('overdue');
    expect((await call('GET', `/admin/tenants/${tenantId}`)).json().subscriptionDetail.status).toBe('past_due');
    // pagou: volta a ficar em dia e o aviso some
    expect((await call('POST', `/admin/invoices/${inv[0].id}/pay`, { method: 'pix' })).statusCode).toBe(204);
    inv = (await call('GET', `/admin/invoices?tenantId=${tenantId}`)).json();
    expect(inv[0]).toMatchObject({ situation: 'paid', method: 'Pix' });
    expect((await call('GET', `/admin/tenants/${tenantId}`)).json().subscriptionDetail.status).toBe('active');
    expect((await call('GET', '/notices', undefined, tenant)).json().filter((n: { automatic: boolean }) => n.automatic)).toEqual([]);

    // comunicado só para esta empresa; quem fecha não vê de novo
    expect((await call('POST', '/admin/announcements', { title: 'Novidade', body: 'Chegou o Mercado Ads no dashboard!', level: 'info', audience: 'tenants', tenantIds: [tenantId] })).statusCode).toBe(201);
    const n2 = (await call('GET', '/notices', undefined, tenant)).json();
    const novidade = n2.find((n: { title: string }) => n.title === 'Novidade');
    expect(novidade).toMatchObject({ automatic: false, level: 'info' });
    expect((await call('POST', `/notices/${novidade.id}/dismiss`, undefined, tenant)).statusCode).toBe(204);
    expect((await call('GET', '/notices', undefined, tenant)).json().some((n: { title: string }) => n.title === 'Novidade')).toBe(false);

    // redefinir senha: senha provisória de 8 números entra e pede para trocar
    const reset = (await call('POST', `/admin/tenants/${tenantId}/users/${detail.people[0].id}/reset-password`)).json();
    expect(reset.temporaryPassword).toMatch(/^\d{8}$/);
    const relog = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: reset.temporaryPassword } });
    expect(relog.statusCode).toBe(200);
    expect(relog.json().mustChangePassword).toBe(true);

    // suspender corta o acesso na hora (sessão aberta e login); reativar devolve
    expect((await call('POST', `/admin/tenants/${tenantId}/status`, { status: 'suspended' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=today', cookies: tenant })).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: reset.temporaryPassword } })).statusCode).toBe(401);
    expect((await call('POST', `/admin/tenants/${tenantId}/status`, { status: 'active' })).statusCode).toBe(204);
    expect((await app.inject({ method: 'GET', url: '/api/v1/dashboard/summary?period=today', cookies: tenant })).statusCode).toBe(200);

    // tudo registrado
    const audit = (await call('GET', '/admin/audit')).json().map((a: { action: string }) => a.action);
    expect(audit).toEqual(expect.arrayContaining(['subscription.save', 'invoice.generate', 'invoice.pay', 'announcement.create', 'user.reset_password', 'tenant.suspend']));
    const ov = (await call('GET', '/admin/overview')).json();
    expect(ov.tenants.total).toBeGreaterThan(0);
  });

  it('recursos por plano e por empresa: padrão, plano, ajuste manual e volta ao plano', async () => {
    const cnpj = randomCnpj();
    const email = `recursos-${cnpj}@teste.dev`;
    await app.inject({ method: 'POST', url: '/api/v1/auth/register', payload: { email, phone: '11912345678', cnpj } });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { email, password: cnpj } });
    const tenant = { nvs_session: login.cookies.find((c) => c.name === 'nvs_session')!.value };
    const features = async () => (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: tenant })).json().tenant.features as string[];
    const tenantId = (await app.inject({ method: 'GET', url: '/api/v1/auth/me', cookies: tenant })).json().tenant.id as string;
    // empresa nova: tudo, menos a Supervisão Full (em teste)
    expect(await features()).toEqual(expect.arrayContaining(['financeiro', 'vendas', 'devolucoes']));
    expect(await features()).not.toContain('full');

    const adminEmail = `master-rec-${cnpj}@nvs.dev`;
    await db.query('INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, $2, $3)', [adminEmail, 'Dono', await hashPassword('senha-master-123')]);
    const al = await app.inject({ method: 'POST', url: '/api/v1/admin/auth/login', payload: { email: adminEmail, password: 'senha-master-123' } });
    const admin = { nvs_admin: al.cookies.find((c) => c.name === 'nvs_admin')!.value };
    const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
      app.inject({ method, url: `/api/v1${url}`, cookies: admin, ...(payload ? { payload: payload as Record<string, unknown> } : {}) });

    // plano Básico: só financeiro e vendas → a empresa assinante recebe exatamente isso
    await call('POST', '/admin/plans', { name: `Básico ${cnpj}`, price: 99, active: true, features: ['financeiro', 'vendas'] });
    const plan = (await call('GET', '/admin/plans')).json().find((p: { name: string }) => p.name === `Básico ${cnpj}`);
    expect(plan.features).toEqual(['financeiro', 'vendas']);
    expect((await call('PUT', `/admin/tenants/${tenantId}/subscription`, { planId: plan.id, status: 'active', billingDay: 5 })).statusCode).toBe(204);
    expect((await features()).sort()).toEqual(['financeiro', 'vendas']);

    // mudar o plano vale na hora para quem segue o plano
    await call('PUT', `/admin/plans/${plan.id}`, { name: plan.name, price: 99, active: true, features: ['financeiro', 'vendas', 'precificador'] });
    expect((await features()).sort()).toEqual(['financeiro', 'precificador', 'vendas']);

    // ajuste manual: só esta empresa, e deixa de seguir o plano
    expect((await call('POST', `/admin/tenants/${tenantId}/features`, { feature: 'full', enabled: true })).statusCode).toBe(204);
    expect(await features()).toContain('full');
    expect((await call('GET', `/admin/tenants/${tenantId}`)).json().featuresCustom).toBe(true);
    await call('PUT', `/admin/plans/${plan.id}`, { name: plan.name, price: 99, active: true, features: ['financeiro'] });
    expect(await features()).toContain('vendas'); // personalizada: não mudou com o plano

    // voltar ao plano
    expect((await call('POST', `/admin/tenants/${tenantId}/features/reset`)).statusCode).toBe(204);
    expect(await features()).toEqual(['financeiro']);
    expect((await call('GET', `/admin/tenants/${tenantId}`)).json().featuresCustom).toBe(false);
  });
});
