import type { FastifyInstance, FastifyReply } from 'fastify';
import {
  changePasswordSchema,
  createUserSchema,
  deleteAccountSchema,
  forgotPasswordSchema,
  loginSchema,
  registerAccountSchema,
  type SessionDto,
  TENANT_FEATURES,
  type TeamMemberInput,
  type TenantFeature,
  type UserDto,
} from '@nvs/shared';
import { z } from 'zod';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { Tenant } from '../../tenancy/index.js';
import type { User } from '../domain/user.js';
import type { IdentityService } from '../application/identity-service.js';

export const SESSION_COOKIE = 'nvs_session';
const REMEMBER_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;

export const toUserDto = (u: User): UserDto => ({
  id: u.id,
  name: u.name,
  email: u.email,
  role: u.role,
  isActive: u.isActive,
  createdAt: u.createdAt.toISOString(),
});

const toSession = (tenant: Tenant, user: User): SessionDto => ({
  user: toUserDto(user),
  tenant: { id: tenant.id, name: tenant.name, slug: tenant.slug, features: (tenant.features ?? []).filter((f): f is TenantFeature => (TENANT_FEATURES as readonly string[]).includes(f)) },
  mustChangePassword: user.mustChangePassword,
});

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os campos informados', r.error.flatten());
  return r.data;
}

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20),
  offset: z.coerce.number().int().min(0).default(0),
});

export function identityRoutes(
  service: IdentityService,
  opts: {
    secureCookies: boolean;
    authRateLimit: number;
    /** Equipe informada no cadastro da conta (criada na mesma transação). */
    onRegisterTeam?: (db: Queryable, ids: { tenantId: string; userId: string }, team: TeamMemberInput[]) => Promise<void>;
    /** Cookies extras que caem junto com a sessão da empresa (ex.: pessoa da equipe). */
    logoutCookies?: string[];
  },
) {
  return async (app: FastifyInstance) => {
    const strictLimit = { config: { rateLimit: { max: opts.authRateLimit, timeWindow: '1 minute' } } };

    /** Sessão em cookie httpOnly: o JavaScript da página nunca enxerga o token. */
    const startSession = (reply: FastifyReply, tenant: Tenant, user: User, remember: boolean) => {
      const seconds = remember ? REMEMBER_SECONDS : DEFAULT_SESSION_SECONDS;
      const token = app.jwt.sign(
        { sub: user.id, tenantId: tenant.id, role: user.role, mcp: user.mustChangePassword },
        { expiresIn: seconds },
      );
      reply.setCookie(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax', // lax: a sessão sobrevive ao retorno do Mercado Livre (navegação GET)
        secure: opts.secureCookies,
        path: '/',
        ...(remember ? { maxAge: seconds } : {}), // sem maxAge = cookie de sessão (fecha com o navegador)
      });
    };

    app.post('/auth/register', strictLimit, async (req, reply) => {
      const input = parse(registerAccountSchema, req.body);
      const team = input.team;
      await service.registerAccount(input, team && opts.onRegisterTeam ? (db, ids) => opts.onRegisterTeam!(db, ids, team) : undefined);
      return reply.code(201).send({ ok: true });
    });

    app.post('/auth/login', strictLimit, async (req, reply) => {
      const input = parse(loginSchema, req.body);
      const { tenant, user } = await service.authenticate(input);
      startSession(reply, tenant, user, input.remember);
      return toSession(tenant, user);
    });

    app.post('/auth/logout', async (_req, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      for (const c of opts.logoutCookies ?? []) reply.clearCookie(c, { path: '/' });
      return reply.code(204).send();
    });

    app.post('/auth/forgot-password', strictLimit, async (req, reply) => {
      await service.requestPasswordReset(parse(forgotPasswordSchema, req.body).email);
      return reply.code(202).send({ ok: true });
    });

    app.get('/auth/me', { preHandler: app.authenticate }, async (req) => {
      const { tenant, user } = await service.getSession(req.user.tenantId, req.user.sub);
      return toSession(tenant, user);
    });

    app.post('/auth/change-password', { preHandler: app.authenticate }, async (req, reply) => {
      const input = parse(changePasswordSchema, req.body);
      const user = await service.changePassword(req.user.tenantId, req.user.sub, input);
      const { tenant } = await service.getSession(req.user.tenantId, req.user.sub);
      startSession(reply, tenant, user, false);
      return toSession(tenant, user);
    });

    app.delete('/account', { ...strictLimit, preHandler: app.authenticate }, async (req, reply) => {
      await service.deleteAccount(req.user.tenantId, req.user.sub, parse(deleteAccountSchema, req.body));
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send();
    });

    app.get('/users', { preHandler: app.requirePermission('users:read') }, async (req) => {
      const { limit, offset } = parse(pageSchema, req.query);
      const users = await service.listUsers(req.user.tenantId, limit, offset);
      return { items: users.map(toUserDto), limit, offset };
    });

    app.post('/users', { preHandler: app.requirePermission('users:manage') }, async (req, reply) => {
      const input = parse(createUserSchema, req.body);
      const user = await service.createUser(req.user.tenantId, input);
      return reply.code(201).send({ user: toUserDto(user) });
    });
  };
}
