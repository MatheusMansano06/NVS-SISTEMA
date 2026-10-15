import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  adminCreateSchema,
  adminLoginSchema,
  announcementSchema,
  couponSchema,
  invoiceCreateSchema,
  invoicePaySchema,
  planSchema,
  subscriptionSchema,
  TENANT_FEATURES,
} from '@nvs/shared';
import { z } from 'zod';
import { NotFoundError, UnauthorizedError, ValidationError } from '../../../shared/kernel/errors.js';
import type { PlatformService } from '../application/platform-service.js';

export const ADMIN_COOKIE = 'nvs_admin';
const ADMIN_SECONDS = 12 * 3600;

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError(r.error.issues[0]?.message ?? 'Revise os dados informados', r.error.flatten());
  return r.data;
}
const uuid = z.string().uuid();
const idOf = (req: FastifyRequest, name = 'id') => {
  const r = uuid.safeParse((req.params as Record<string, string>)[name]);
  if (!r.success) throw new NotFoundError('Não encontrado');
  return r.data;
};

/**
 * Painel Master (dono do NVS Tech) em /admin/*: sessão própria (cookie nvs_admin, token typ=admin, que nunca vale como
 * sessão de empresa), conferida no banco a cada chamada (desativar uma master vale na hora). Mais os avisos que os
 * usuários das empresas veem (/notices).
 */
export function platformRoutes(service: PlatformService, opts: { secureCookies: boolean }) {
  return async (app: FastifyInstance) => {
    const adminOf = async (req: FastifyRequest) => {
      const raw = req.cookies[ADMIN_COOKIE];
      if (!raw) throw new UnauthorizedError('Entre com a conta master');
      let t: { sub: string; typ?: string };
      try {
        t = app.jwt.verify<{ sub: string; typ?: string }>(raw);
      } catch {
        throw new UnauthorizedError('Sessão master expirada: entre de novo');
      }
      if (t.typ !== 'admin') throw new UnauthorizedError('Entre com a conta master');
      const a = await service.admin(t.sub);
      if (!a) throw new UnauthorizedError('Conta master desativada');
      return a;
    };
    const by = async (req: FastifyRequest) => (await adminOf(req)).id;
    const noContent = (reply: FastifyReply) => reply.code(204).send();

    // ---------- sessão
    app.post('/admin/auth/login', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req, reply) => {
      const b = parse(adminLoginSchema, req.body);
      const a = await service.login(b.email, b.password);
      // token sem empresa (tenantId vazio) e typ=admin: o authenticate das empresas recusa
      reply.setCookie(ADMIN_COOKIE, app.jwt.sign({ sub: a.id, tenantId: '', role: 'viewer', typ: 'admin' }, { expiresIn: ADMIN_SECONDS }), {
        path: '/', httpOnly: true, sameSite: 'strict', secure: opts.secureCookies, maxAge: ADMIN_SECONDS,
      });
      return a;
    });
    app.post('/admin/auth/logout', async (_req, reply) => reply.clearCookie(ADMIN_COOKIE, { path: '/' }).code(204).send());
    app.get('/admin/me', async (req) => adminOf(req));

    // ---------- visão geral e empresas
    app.get('/admin/overview', async (req) => {
      await adminOf(req);
      await service.markPastDue(); // mensalidade vencida → assinatura em atraso
      return service.overview();
    });
    app.get('/admin/tenants', async (req) => {
      await adminOf(req);
      await service.markPastDue(); // mensalidade vencida → assinatura em atraso
      return service.tenants((req.query as { q?: string }).q);
    });
    app.get('/admin/tenants/:id', async (req) => {
      await adminOf(req);
      return service.tenant(idOf(req));
    });
    app.post('/admin/tenants/:id/status', async (req, reply) => {
      const b = parse(z.object({ status: z.enum(['active', 'suspended']) }), req.body);
      await service.setTenantStatus(await by(req), idOf(req), b.status);
      return noContent(reply);
    });
    app.post('/admin/tenants/:id/features', async (req, reply) => {
      const b = parse(z.object({ feature: z.enum(TENANT_FEATURES), enabled: z.boolean() }), req.body);
      await service.setTenantFeature(await by(req), idOf(req), b.feature, b.enabled);
      return noContent(reply);
    });
    app.post('/admin/tenants/:id/features/reset', async (req, reply) => {
      await service.resetTenantFeatures(await by(req), idOf(req));
      return noContent(reply);
    });
    app.post('/admin/tenants/:id/users/:userId/reset-password', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      service.resetPassword(await by(req), idOf(req), idOf(req, 'userId')),
    );
    app.put('/admin/tenants/:id/subscription', async (req, reply) => {
      await service.saveSubscription(await by(req), idOf(req), parse(subscriptionSchema, req.body));
      return noContent(reply);
    });

    // ---------- planos e cupons
    app.get('/admin/plans', async (req) => {
      await adminOf(req);
      return service.plans();
    });
    app.post('/admin/plans', async (req, reply) => {
      await service.savePlan(await by(req), parse(planSchema, req.body));
      return reply.code(201).send();
    });
    app.put('/admin/plans/:id', async (req, reply) => {
      await service.savePlan(await by(req), parse(planSchema, req.body), idOf(req));
      return noContent(reply);
    });
    app.get('/admin/coupons', async (req) => {
      await adminOf(req);
      return service.coupons();
    });
    app.post('/admin/coupons', async (req, reply) => {
      const b = parse(couponSchema, req.body);
      await service.saveCoupon(await by(req), { ...b, description: b.description ?? null, months: b.months ?? null, maxRedemptions: b.maxRedemptions ?? null, validUntil: b.validUntil ?? null });
      return reply.code(201).send();
    });
    app.put('/admin/coupons/:id', async (req, reply) => {
      const b = parse(couponSchema, req.body);
      await service.saveCoupon(await by(req), { ...b, description: b.description ?? null, months: b.months ?? null, maxRedemptions: b.maxRedemptions ?? null, validUntil: b.validUntil ?? null }, idOf(req));
      return noContent(reply);
    });
    app.delete('/admin/coupons/:id', async (req, reply) => {
      await service.deleteCoupon(await by(req), idOf(req));
      return noContent(reply);
    });

    // ---------- mensalidades
    app.get('/admin/invoices', async (req) => {
      await adminOf(req);
      await service.markPastDue(); // mensalidade vencida → assinatura em atraso
      const q = req.query as { situation?: string; period?: string; tenantId?: string };
      return service.invoices({ situation: q.situation || undefined, period: q.period || undefined, tenantId: q.tenantId || undefined });
    });
    app.post('/admin/invoices/generate', async (req) => {
      const b = parse(z.object({ period: z.string().regex(/^\d{4}-\d{2}-01$/) }), req.body);
      const r = await service.generateMonth(await by(req), b.period);
      await service.markPastDue();
      return r;
    });
    app.post('/admin/invoices', async (req, reply) => {
      await service.createInvoice(await by(req), parse(invoiceCreateSchema, req.body));
      return reply.code(201).send();
    });
    app.post('/admin/invoices/:id/pay', async (req, reply) => {
      await service.payInvoice(await by(req), idOf(req), parse(invoicePaySchema, req.body));
      return noContent(reply);
    });
    app.post('/admin/invoices/:id/status', async (req, reply) => {
      await service.setInvoiceStatus(await by(req), idOf(req), parse(z.object({ status: z.enum(['pending', 'canceled']) }), req.body).status);
      return noContent(reply);
    });

    // ---------- comunicados
    app.get('/admin/announcements', async (req) => {
      await adminOf(req);
      return service.announcements();
    });
    app.post('/admin/announcements', async (req, reply) => {
      await service.createAnnouncement(await by(req), parse(announcementSchema, req.body));
      return reply.code(201).send();
    });
    app.post('/admin/announcements/:id/active', async (req, reply) => {
      await service.setAnnouncementActive(await by(req), idOf(req), parse(z.object({ active: z.boolean() }), req.body).active);
      return noContent(reply);
    });

    // ---------- masters e registro
    app.get('/admin/admins', async (req) => {
      await adminOf(req);
      return service.admins();
    });
    app.post('/admin/admins', async (req, reply) => reply.code(201).send(await service.createAdmin(await by(req), parse(adminCreateSchema, req.body))));
    app.post('/admin/admins/:id/active', async (req, reply) => {
      await service.setAdminActive(await by(req), idOf(req), parse(z.object({ active: z.boolean() }), req.body).active);
      return noContent(reply);
    });
    app.get('/admin/audit', async (req) => {
      await adminOf(req);
      return service.auditLog();
    });

    // ---------- o que os usuários das empresas veem
    app.get('/notices', { preHandler: app.authenticate }, async (req) => service.noticesFor(req.user.tenantId, req.user.sub, req.user.role));
    app.post('/notices/:id/dismiss', { preHandler: app.authenticate }, async (req, reply) => {
      await service.dismiss(req.user.sub, (req.params as { id: string }).id);
      return noContent(reply);
    });
  };
}
