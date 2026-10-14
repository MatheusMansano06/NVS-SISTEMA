import { randomInt } from 'node:crypto';
import type {
  AdminDto,
  AnnouncementDto,
  AuditDto,
  CouponDto,
  InvoiceDto,
  PlanDto,
  PlatformOverviewDto,
  SubscriptionStatus,
  TenantDetailDto,
  TenantRowDto,
  UserNoticeDto,
} from '@nvs/shared';
import type { Database } from '../../../shared/infrastructure/database.js';
import { hashPassword, verifyPassword } from '../../../shared/infrastructure/password.js';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../../shared/kernel/errors.js';
import { couponProblem, cyclesFor, discountFor, dueDateOf, invoiceSituation, monthKey, type CouponRule } from '../domain/billing.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
type Json = any;

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));
const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
const day = (d: Date | string | null | undefined) => (d ? (typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10)) : null);
const DUMMY_HASH = 'scrypt$00000000000000000000000000000000$' + '0'.repeat(128);
const METHOD_LABEL: Record<string, string> = { pix: 'Pix', boleto: 'Boleto', cartao: 'Cartão', transferencia: 'Transferência', outro: 'Outro' };

export interface PlatformDeps {
  today: () => string; // dia de São Paulo
  forgetTenant: (tenantId: string) => Promise<void>; // limpa o cache da empresa (suspensão vale na hora)
}

/**
 * Painel Master do NVS Tech. As tabelas da plataforma são globais; os dados de cada empresa (usuários, vendas) são lidos
 * empresa por empresa com o isolamento normal (withTenant). Toda alteração fica registrada em admin_audit.
 */
export class PlatformService {
  constructor(
    private readonly db: Database,
    private readonly deps: PlatformDeps,
  ) {}

  // ================= administradores
  /** Primeiro administrador vem das variáveis de ambiente, uma única vez (sem administrador nenhum no banco). */
  async bootstrap(email?: string, password?: string): Promise<boolean> {
    if (!email || !password) return false;
    const { rows } = await this.db.query<{ n: string }>('SELECT count(*) AS n FROM platform_admins');
    if (Number(rows[0]?.n) > 0) return false;
    await this.db.query('INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, $2, $3)', [
      email.trim().toLowerCase(), 'Master', await hashPassword(password),
    ]);
    return true;
  }

  async login(email: string, password: string): Promise<AdminDto> {
    const { rows } = await this.db.query<Json>('SELECT * FROM platform_admins WHERE email = $1', [email]);
    const a = rows[0];
    const ok = await verifyPassword(password, a?.password_hash ?? DUMMY_HASH);
    if (!a || !ok || !a.is_active) throw new UnauthorizedError('E-mail ou senha incorretos');
    await this.db.query('UPDATE platform_admins SET last_login_at = now() WHERE id = $1', [a.id]);
    await this.audit(a.id, 'login', null);
    return this.adminDto(a);
  }

  async admin(id: string): Promise<AdminDto | null> {
    const { rows } = await this.db.query<Json>('SELECT * FROM platform_admins WHERE id = $1 AND is_active', [id]);
    return rows[0] ? this.adminDto(rows[0]) : null;
  }

  async admins(): Promise<AdminDto[]> {
    const { rows } = await this.db.query<Json>('SELECT * FROM platform_admins ORDER BY created_at');
    return rows.map((a) => this.adminDto(a));
  }

  async createAdmin(by: string, input: { email: string; name: string; password: string }): Promise<AdminDto> {
    const { rows } = await this.db
      .query<Json>('INSERT INTO platform_admins (email, name, password_hash) VALUES ($1, $2, $3) RETURNING *', [input.email, input.name, await hashPassword(input.password)])
      .catch((err) => {
        if ((err as { code?: string }).code === '23505') throw new ValidationError('Já existe uma master com este e-mail');
        throw err;
      });
    await this.audit(by, 'admin.create', input.email);
    return this.adminDto(rows[0]);
  }

  async setAdminActive(by: string, id: string, active: boolean) {
    if (by === id && !active) throw new ValidationError('Você não pode desativar a si mesmo.');
    const r = await this.db.query('UPDATE platform_admins SET is_active = $2 WHERE id = $1', [id, active]);
    if (!r.rowCount) throw new NotFoundError('Administrador não encontrado');
    await this.audit(by, active ? 'admin.activate' : 'admin.deactivate', id);
  }

  private adminDto(a: Json): AdminDto {
    return { id: a.id, email: a.email, name: a.name, isActive: a.is_active, lastLoginAt: iso(a.last_login_at), createdAt: iso(a.created_at)! };
  }

  // ================= visão geral
  async overview(): Promise<PlatformOverviewDto> {
    const today = this.deps.today();
    const t = (
      await this.db.query<Json>(
        `SELECT count(*) AS total, count(*) FILTER (WHERE status = 'active') AS active, count(*) FILTER (WHERE status = 'suspended') AS suspended,
                count(*) FILTER (WHERE created_at >= now() - interval '30 days') AS new30,
                (SELECT count(DISTINCT tenant_id) FROM marketplace_identities) AS ml
           FROM tenants`,
      )
    ).rows[0];
    const subs = (await this.db.query<{ status: SubscriptionStatus; n: string }>('SELECT status, count(*) AS n FROM subscriptions GROUP BY status')).rows;
    const counted = subs.reduce((s, r) => s + Number(r.n), 0);
    const mrr = (
      await this.db.query<{ v: string }>(
        `SELECT coalesce(sum(coalesce(s.price, p.price)), 0) AS v FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id WHERE s.status IN ('active', 'past_due')`,
      )
    ).rows[0]!.v;
    const inv = (
      await this.db.query<Json>(
        `SELECT count(*) FILTER (WHERE status = 'pending' AND due_date >= $1) AS pending,
                coalesce(sum(total) FILTER (WHERE status = 'pending' AND due_date >= $1), 0) AS pending_total,
                count(*) FILTER (WHERE status = 'pending' AND due_date < $1) AS overdue,
                coalesce(sum(total) FILTER (WHERE status = 'pending' AND due_date < $1), 0) AS overdue_total,
                coalesce(sum(total) FILTER (WHERE status = 'paid' AND paid_at >= date_trunc('month', now())), 0) AS paid_month
           FROM invoices`,
        [today],
      )
    ).rows[0];
    const recent = (await this.db.query<Json>('SELECT id, name, created_at FROM tenants ORDER BY created_at DESC LIMIT 6')).rows;
    const by = (s: SubscriptionStatus) => Number(subs.find((r) => r.status === s)?.n ?? 0);
    return {
      tenants: { total: Number(t.total), active: Number(t.active), suspended: Number(t.suspended), newLast30: Number(t.new30), mlConnected: Number(t.ml) },
      subscriptions: { trial: by('trial'), active: by('active'), past_due: by('past_due'), canceled: by('canceled'), none: Number(t.total) - counted },
      mrr: Number(mrr),
      invoices: {
        pending: Number(inv.pending), pendingTotal: Number(inv.pending_total), overdue: Number(inv.overdue), overdueTotal: Number(inv.overdue_total),
        paidThisMonth: Number(inv.paid_month),
      },
      recent: recent.map((r) => ({ id: r.id, name: r.name, createdAt: iso(r.created_at)! })),
    };
  }

  // ================= empresas
  async tenants(q?: string): Promise<TenantRowDto[]> {
    const today = this.deps.today();
    const { rows } = await this.db.query<Json>(
      `SELECT t.id, t.name, t.cnpj, t.phone, t.status, t.created_at,
              (SELECT li.email FROM login_identities li WHERE li.tenant_id = t.id ORDER BY li.email LIMIT 1) AS owner_email,
              (SELECT count(*) FROM login_identities li WHERE li.tenant_id = t.id) AS users,
              EXISTS (SELECT 1 FROM marketplace_identities mi WHERE mi.tenant_id = t.id) AS ml,
              s.status AS sub_status, coalesce(s.price, p.price) AS sub_price, p.name AS plan_name,
              (SELECT count(*) FROM invoices i WHERE i.tenant_id = t.id AND i.status = 'pending' AND i.due_date < $2) AS overdue
         FROM tenants t
         LEFT JOIN subscriptions s ON s.tenant_id = t.id
         LEFT JOIN plans p ON p.id = s.plan_id
        WHERE ($1::text IS NULL OR t.name ILIKE '%' || $1 || '%' OR t.cnpj LIKE '%' || regexp_replace($1, '\\D', '', 'g') || '%'
               OR EXISTS (SELECT 1 FROM login_identities li WHERE li.tenant_id = t.id AND li.email ILIKE '%' || $1 || '%'))
        ORDER BY t.created_at DESC LIMIT 500`,
      [q?.trim() || null, today],
    );
    return rows.map((r) => this.tenantRow(r));
  }

  private tenantRow(r: Json): TenantRowDto {
    return {
      id: r.id, name: r.name, cnpj: r.cnpj, phone: r.phone, status: r.status, createdAt: iso(r.created_at)!, ownerEmail: r.owner_email,
      users: Number(r.users), mlConnected: Boolean(r.ml),
      subscription: r.sub_status ? { status: r.sub_status, planName: r.plan_name, price: num(r.sub_price) } : null,
      overdue: Number(r.overdue ?? 0),
    };
  }

  async tenant(id: string): Promise<TenantDetailDto> {
    const row = (await this.tenants()).find((t) => t.id === id) ?? null;
    if (!row) throw new NotFoundError('Empresa não encontrada');
    const inner = await this.db.withTenant(id, async (db) => {
      const people = (await db.query<Json>('SELECT id, name, email, role, is_active, must_change_password, created_at FROM users ORDER BY created_at')).rows;
      const ml = (await db.query<Json>('SELECT nickname, marketplace FROM marketplace_accounts WHERE source = $1 ORDER BY nickname', ['marketplace'])).rows;
      const sales = (
        await db.query<Json>(
          `SELECT count(*) AS orders, coalesce(sum(gross_amount), 0) AS revenue FROM orders WHERE status = 'paid' AND ordered_at >= now() - interval '30 days'`,
        )
      ).rows[0];
      return { people, ml, sales };
    });
    const sub = (await this.db.query<Json>('SELECT s.*, c.code AS coupon_code FROM subscriptions s LEFT JOIN coupons c ON c.id = s.coupon_id WHERE s.tenant_id = $1', [id])).rows[0];
    return {
      ...row,
      people: inner.people.map((p: Json) => ({
        id: p.id, name: p.name, email: p.email, role: p.role, isActive: p.is_active, mustChangePassword: p.must_change_password, createdAt: iso(p.created_at)!,
      })),
      mlAccounts: inner.ml.map((m: Json) => ({ nickname: m.nickname, marketplace: m.marketplace })),
      sales30: { orders: Number(inner.sales.orders), revenue: Number(inner.sales.revenue) },
      subscriptionDetail: sub
        ? {
            planId: sub.plan_id, price: num(sub.price), status: sub.status, trialEndsOn: day(sub.trial_ends_on), billingDay: sub.billing_day,
            couponCode: sub.coupon_code, couponCyclesLeft: sub.coupon_cycles_left, notes: sub.notes,
          }
        : null,
      invoices: await this.invoices({ tenantId: id }),
    };
  }

  async setTenantStatus(by: string, id: string, status: 'active' | 'suspended') {
    const r = await this.db.query('UPDATE tenants SET status = $2 WHERE id = $1', [id, status]);
    if (!r.rowCount) throw new NotFoundError('Empresa não encontrada');
    await this.deps.forgetTenant(id);
    await this.audit(by, status === 'suspended' ? 'tenant.suspend' : 'tenant.activate', id);
  }

  /** Senha provisória de 8 números: a pessoa entra com ela e o sistema obriga a criar uma nova. */
  async resetPassword(by: string, tenantId: string, userId: string): Promise<{ email: string; temporaryPassword: string }> {
    const temp = String(randomInt(10_000_000, 99_999_999));
    const hash = await hashPassword(temp);
    const email = await this.db.withTenant(tenantId, async (db) => {
      const { rows } = await db.query<{ email: string }>(
        'UPDATE users SET password_hash = $2, must_change_password = true WHERE id = $1 RETURNING email',
        [userId, hash],
      );
      return rows[0]?.email;
    });
    if (!email) throw new NotFoundError('Usuário não encontrado');
    await this.audit(by, 'user.reset_password', email, { tenantId });
    return { email, temporaryPassword: temp };
  }

  // ================= planos
  async plans(): Promise<PlanDto[]> {
    const { rows } = await this.db.query<Json>(
      `SELECT p.*, (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id AND s.status <> 'canceled') AS subscribers FROM plans p ORDER BY p.price`,
    );
    return rows.map((p) => ({ id: p.id, name: p.name, price: Number(p.price), description: p.description, active: p.active, subscribers: Number(p.subscribers) }));
  }

  async savePlan(by: string, input: { name: string; price: number; description?: string | null; active: boolean }, id?: string): Promise<void> {
    if (id) {
      const r = await this.db.query('UPDATE plans SET name = $2, price = $3, description = $4, active = $5 WHERE id = $1', [id, input.name, input.price, input.description ?? null, input.active]);
      if (!r.rowCount) throw new NotFoundError('Plano não encontrado');
    } else {
      await this.db.query('INSERT INTO plans (name, price, description, active) VALUES ($1, $2, $3, $4)', [input.name, input.price, input.description ?? null, input.active]);
    }
    await this.audit(by, id ? 'plan.update' : 'plan.create', input.name, { price: input.price });
  }

  // ================= cupons
  async coupons(): Promise<CouponDto[]> {
    const { rows } = await this.db.query<Json>('SELECT * FROM coupons ORDER BY created_at DESC');
    return rows.map((c) => this.couponDto(c));
  }

  private couponDto(c: Json): CouponDto {
    return {
      id: c.id, code: c.code, description: c.description, kind: c.kind, value: Number(c.value), duration: c.duration, months: c.months,
      maxRedemptions: c.max_redemptions, redemptions: c.redemptions, validUntil: day(c.valid_until), active: c.active,
    };
  }

  async saveCoupon(by: string, input: Omit<CouponDto, 'id' | 'redemptions'>, id?: string): Promise<void> {
    const params = [
      input.code, input.description ?? null, input.kind, input.value, input.duration, input.duration === 'months' ? input.months : null,
      input.maxRedemptions ?? null, input.validUntil ?? null, input.active,
    ];
    try {
      if (id) {
        const r = await this.db.query(
          `UPDATE coupons SET code = $2, description = $3, kind = $4, value = $5, duration = $6, months = $7, max_redemptions = $8,
                  valid_until = $9, active = $10 WHERE id = $1`,
          [id, ...params],
        );
        if (!r.rowCount) throw new NotFoundError('Cupom não encontrado');
      } else {
        await this.db.query(
          `INSERT INTO coupons (code, description, kind, value, duration, months, max_redemptions, valid_until, active)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          params,
        );
      }
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ValidationError('Já existe um cupom com este código');
      throw err;
    }
    await this.audit(by, id ? 'coupon.update' : 'coupon.create', input.code);
  }

  async deleteCoupon(by: string, id: string) {
    const { rows } = await this.db.query<Json>('SELECT code, redemptions FROM coupons WHERE id = $1', [id]);
    if (!rows[0]) throw new NotFoundError('Cupom não encontrado');
    if (rows[0].redemptions > 0) throw new ValidationError('Cupom já usado: desative em vez de apagar (o histórico das mensalidades guarda o código).');
    await this.db.query('DELETE FROM coupons WHERE id = $1', [id]);
    await this.audit(by, 'coupon.delete', rows[0].code);
  }

  private couponRule(c: Json): CouponRule {
    return {
      kind: c.kind, value: Number(c.value), duration: c.duration, months: c.months, maxRedemptions: c.max_redemptions,
      redemptions: c.redemptions, validUntil: day(c.valid_until), active: c.active,
    };
  }

  // ================= assinaturas
  async saveSubscription(
    by: string,
    tenantId: string,
    input: { planId?: string | null; price?: number | null; status: SubscriptionStatus; trialEndsOn?: string | null; billingDay: number; couponCode?: string | null; notes?: string | null },
  ): Promise<void> {
    const exists = await this.db.query('SELECT 1 FROM tenants WHERE id = $1', [tenantId]);
    if (!exists.rowCount) throw new NotFoundError('Empresa não encontrada');
    if (!input.planId && (input.price === null || input.price === undefined)) throw new ValidationError('Escolha um plano ou informe o valor combinado.');
    const cur = (await this.db.query<Json>('SELECT s.coupon_id, s.coupon_cycles_left, c.code FROM subscriptions s LEFT JOIN coupons c ON c.id = s.coupon_id WHERE s.tenant_id = $1', [tenantId])).rows[0];
    let couponId: string | null = cur?.coupon_id ?? null;
    let cycles: number | null = cur?.coupon_cycles_left ?? null;
    const code = input.couponCode?.trim() || null;
    if (!code) {
      couponId = null;
      cycles = null;
    } else if (code !== cur?.code) {
      const c = (await this.db.query<Json>('SELECT * FROM coupons WHERE code = $1', [code])).rows[0];
      if (!c) throw new ValidationError(`Cupom ${code} não existe.`);
      const problem = couponProblem(this.couponRule(c), this.deps.today());
      if (problem) throw new ValidationError(problem);
      couponId = c.id;
      cycles = cyclesFor(this.couponRule(c));
      await this.db.query('UPDATE coupons SET redemptions = redemptions + 1 WHERE id = $1', [c.id]);
    }
    await this.db.query(
      `INSERT INTO subscriptions (tenant_id, plan_id, price, status, trial_ends_on, billing_day, coupon_id, coupon_cycles_left, notes, canceled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, CASE WHEN $4 = 'canceled' THEN now() END)
       ON CONFLICT (tenant_id) DO UPDATE SET plan_id = EXCLUDED.plan_id, price = EXCLUDED.price, status = EXCLUDED.status,
         trial_ends_on = EXCLUDED.trial_ends_on, billing_day = EXCLUDED.billing_day, coupon_id = EXCLUDED.coupon_id,
         coupon_cycles_left = EXCLUDED.coupon_cycles_left, notes = EXCLUDED.notes,
         canceled_at = CASE WHEN EXCLUDED.status = 'canceled' THEN coalesce(subscriptions.canceled_at, now()) END, updated_at = now()`,
      [tenantId, input.planId ?? null, input.price ?? null, input.status, input.trialEndsOn ?? null, input.billingDay, couponId, cycles, input.notes ?? null],
    );
    await this.audit(by, 'subscription.save', tenantId, { status: input.status, planId: input.planId, price: input.price, coupon: code });
  }

  // ================= mensalidades
  async invoices(f: { tenantId?: string; situation?: string; period?: string } = {}): Promise<InvoiceDto[]> {
    const today = this.deps.today();
    const { rows } = await this.db.query<Json>(
      `SELECT i.*, t.name AS tenant_name FROM invoices i JOIN tenants t ON t.id = i.tenant_id
        WHERE ($1::uuid IS NULL OR i.tenant_id = $1) AND ($2::date IS NULL OR i.period = $2)
        ORDER BY i.due_date DESC, t.name LIMIT 1000`,
      [f.tenantId ?? null, f.period ?? null],
    );
    const list = rows.map((i): InvoiceDto => ({
      id: i.id, tenantId: i.tenant_id, tenantName: i.tenant_name, period: day(i.period)!, description: i.description, amount: Number(i.amount),
      discount: Number(i.discount), total: Number(i.total), couponCode: i.coupon_code, dueDate: day(i.due_date)!,
      situation: invoiceSituation(i.status, day(i.due_date)!, today), paidAt: iso(i.paid_at), method: i.method ? (METHOD_LABEL[i.method] ?? i.method) : null, notes: i.notes,
    }));
    return f.situation ? list.filter((i) => i.situation === f.situation) : list;
  }

  /**
   * Gera as mensalidades do mês para as assinaturas ativas (e em atraso): valor do plano ou o combinado, com o desconto
   * do cupom enquanto ele valer. Mês já gerado para a empresa não duplica. Teste que acabou vira assinatura ativa.
   */
  async generateMonth(by: string, period: string): Promise<{ created: number; skipped: number }> {
    const today = this.deps.today();
    await this.db.query(`UPDATE subscriptions SET status = 'active', updated_at = now() WHERE status = 'trial' AND trial_ends_on IS NOT NULL AND trial_ends_on < $1`, [today]);
    const subs = (
      await this.db.query<Json>(
        `SELECT s.*, coalesce(s.price, p.price) AS amount, p.name AS plan_name, c.code, c.kind, c.value, c.active AS coupon_active
           FROM subscriptions s LEFT JOIN plans p ON p.id = s.plan_id LEFT JOIN coupons c ON c.id = s.coupon_id
          WHERE s.status IN ('active', 'past_due')`,
      )
    ).rows;
    let created = 0;
    let skipped = 0;
    const [y, m] = [period.slice(0, 4), period.slice(5, 7)];
    for (const s of subs) {
      const amount = num(s.amount) ?? 0;
      const withCoupon = s.coupon_id && s.coupon_active && (s.coupon_cycles_left === null || s.coupon_cycles_left > 0);
      const discount = withCoupon ? discountFor(amount, { kind: s.kind, value: Number(s.value) }) : 0;
      const r = await this.db.query(
        `INSERT INTO invoices (tenant_id, period, description, amount, discount, total, coupon_code, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (tenant_id, period) DO NOTHING`,
        [s.tenant_id, period, `Mensalidade ${m}/${y}${s.plan_name ? ` · ${s.plan_name}` : ''}`, amount, discount, Math.max(0, amount - discount),
          withCoupon ? s.code : null, dueDateOf(period, s.billing_day)],
      );
      if (r.rowCount) {
        created++;
        if (withCoupon && s.coupon_cycles_left !== null) {
          await this.db.query('UPDATE subscriptions SET coupon_cycles_left = coupon_cycles_left - 1 WHERE tenant_id = $1', [s.tenant_id]);
        }
      } else skipped++;
    }
    await this.audit(by, 'invoice.generate', period, { created, skipped });
    return { created, skipped };
  }

  async createInvoice(by: string, input: { tenantId: string; period: string; description: string; amount: number; dueDate: string }) {
    try {
      await this.db.query(
        `INSERT INTO invoices (tenant_id, period, description, amount, total, due_date) VALUES ($1, $2, $3, $4, $4, $5)`,
        [input.tenantId, input.period, input.description, input.amount, input.dueDate],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') throw new ValidationError('Esta empresa já tem cobrança neste mês.');
      if ((err as { code?: string }).code === '23503') throw new NotFoundError('Empresa não encontrada');
      throw err;
    }
    await this.audit(by, 'invoice.create', input.tenantId, { period: input.period, amount: input.amount });
  }

  async payInvoice(by: string, id: string, input: { method: string; paidOn?: string | null; notes?: string | null }) {
    const { rows } = await this.db.query<Json>(
      `UPDATE invoices SET status = 'paid', method = $2, paid_at = coalesce($3::date::timestamptz, now()), notes = coalesce($4, notes)
        WHERE id = $1 AND status <> 'canceled' RETURNING tenant_id`,
      [id, input.method, input.paidOn ?? null, input.notes ?? null],
    );
    if (!rows[0]) throw new NotFoundError('Mensalidade não encontrada (ou cancelada)');
    // pagou tudo o que estava atrasado: a assinatura volta a ficar em dia
    await this.db.query(
      `UPDATE subscriptions SET status = 'active', updated_at = now() WHERE tenant_id = $1 AND status = 'past_due'
         AND NOT EXISTS (SELECT 1 FROM invoices WHERE tenant_id = $1 AND status = 'pending' AND due_date < $2)`,
      [rows[0].tenant_id, this.deps.today()],
    );
    await this.audit(by, 'invoice.pay', id, { method: input.method });
  }

  async setInvoiceStatus(by: string, id: string, status: 'pending' | 'canceled') {
    const r = await this.db.query(`UPDATE invoices SET status = $2, paid_at = NULL, method = NULL WHERE id = $1`, [id, status]);
    if (!r.rowCount) throw new NotFoundError('Mensalidade não encontrada');
    await this.audit(by, status === 'canceled' ? 'invoice.cancel' : 'invoice.reopen', id);
  }

  /** Assinaturas com mensalidade vencida viram "em atraso" (roda junto da geração e do agendador). */
  async markPastDue(): Promise<number> {
    const r = await this.db.query(
      `UPDATE subscriptions s SET status = 'past_due', updated_at = now()
        WHERE s.status = 'active' AND EXISTS (SELECT 1 FROM invoices i WHERE i.tenant_id = s.tenant_id AND i.status = 'pending' AND i.due_date < $1)`,
      [this.deps.today()],
    );
    return r.rowCount ?? 0;
  }

  // ================= comunicados
  async announcements(): Promise<AnnouncementDto[]> {
    const { rows } = await this.db.query<Json>(
      `SELECT a.*, (SELECT count(*) FROM announcement_dismissals d WHERE d.announcement_id = a.id) AS dismissals FROM announcements a ORDER BY a.created_at DESC LIMIT 200`,
    );
    return rows.map((a) => ({
      id: a.id, title: a.title, body: a.body, level: a.level, audience: a.audience, tenantIds: a.tenant_ids, startsAt: iso(a.starts_at)!,
      endsAt: iso(a.ends_at), active: a.active, dismissals: Number(a.dismissals), createdAt: iso(a.created_at)!,
    }));
  }

  async createAnnouncement(
    by: string,
    input: { title: string; body: string; level: string; audience: 'all' | 'tenants'; tenantIds: string[]; startsAt?: string | null; endsAt?: string | null },
  ) {
    if (input.audience === 'tenants' && !input.tenantIds.length) throw new ValidationError('Escolha ao menos uma empresa.');
    if (input.startsAt && input.endsAt && input.endsAt <= input.startsAt) throw new ValidationError('O fim precisa ser depois do início.');
    await this.db.query(
      `INSERT INTO announcements (title, body, level, audience, tenant_ids, starts_at, ends_at, created_by)
       VALUES ($1, $2, $3, $4, $5, coalesce($6::timestamptz, now()), $7, $8)`,
      [input.title, input.body, input.level, input.audience, input.audience === 'tenants' ? input.tenantIds : [], input.startsAt ?? null, input.endsAt ?? null, by],
    );
    await this.audit(by, 'announcement.create', input.title, { audience: input.audience, tenants: input.tenantIds.length });
  }

  async setAnnouncementActive(by: string, id: string, active: boolean) {
    const r = await this.db.query('UPDATE announcements SET active = $2 WHERE id = $1', [id, active]);
    if (!r.rowCount) throw new NotFoundError('Comunicado não encontrado');
    await this.audit(by, active ? 'announcement.activate' : 'announcement.end', id);
  }

  /** O que aparece para o usuário: comunicados válidos agora e avisos automáticos da assinatura (mensalidade em atraso). */
  async noticesFor(tenantId: string, userId: string, role: string): Promise<UserNoticeDto[]> {
    const { rows } = await this.db.query<Json>(
      `SELECT a.id, a.title, a.body, a.level FROM announcements a
        WHERE a.active AND a.starts_at <= now() AND (a.ends_at IS NULL OR a.ends_at > now())
          AND (a.audience = 'all' OR $1 = ANY(a.tenant_ids))
          AND NOT EXISTS (SELECT 1 FROM announcement_dismissals d WHERE d.announcement_id = a.id AND d.user_id = $2)
        ORDER BY a.starts_at DESC LIMIT 5`,
      [tenantId, userId],
    );
    const notices: UserNoticeDto[] = rows.map((a) => ({ id: a.id, title: a.title, body: a.body, level: a.level, automatic: false }));
    // aviso automático: só para quem administra a conta (dono/admin)
    if (role === 'owner' || role === 'admin') {
      const overdue = (
        await this.db.query<Json>(
          `SELECT description, total, due_date FROM invoices WHERE tenant_id = $1 AND status = 'pending' AND due_date < $2 ORDER BY due_date LIMIT 3`,
          [tenantId, this.deps.today()],
        )
      ).rows;
      for (const i of overdue) {
        const venc = day(i.due_date)!;
        notices.unshift({
          id: `auto-fatura-${venc}`,
          title: 'Mensalidade em aberto',
          body: `${i.description} (R$ ${Number(i.total).toLocaleString('pt-BR', { minimumFractionDigits: 2 })}) venceu em ${venc.slice(8, 10)}/${venc.slice(5, 7)}. Fale com o NVS Tech para regularizar e evitar a suspensão do acesso.`,
          level: 'danger',
          automatic: true,
        });
      }
    }
    return notices;
  }

  async dismiss(userId: string, announcementId: string) {
    if (!/^[0-9a-f-]{36}$/.test(announcementId)) return; // aviso automático não se dispensa
    await this.db.query('INSERT INTO announcement_dismissals (announcement_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [announcementId, userId]);
  }

  // ================= registro
  async auditLog(): Promise<AuditDto[]> {
    const { rows } = await this.db.query<Json>(
      `SELECT l.*, a.name AS admin_name FROM admin_audit l LEFT JOIN platform_admins a ON a.id = l.admin_id ORDER BY l.created_at DESC LIMIT 300`,
    );
    return rows.map((r) => ({ id: r.id, adminName: r.admin_name, action: r.action, target: r.target, details: r.details, createdAt: iso(r.created_at)! }));
  }

  private async audit(adminId: string, action: string, target: string | null, details: Record<string, unknown> = {}) {
    await this.db.query('INSERT INTO admin_audit (admin_id, action, target, details) VALUES ($1, $2, $3, $4)', [adminId, action, target, JSON.stringify(details)]);
  }

  /** Mês corrente (1º dia), para a tela de gerar mensalidades. */
  currentPeriod() {
    return monthKey(this.deps.today());
  }
}
