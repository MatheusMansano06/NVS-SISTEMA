import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  areaAllows,
  changePinSchema,
  createOperatorSchema,
  pinLoginSchema,
  teamSetupSchema,
  updateOperatorSchema,
  type PersonSessionDto,
  type TeamDto,
  type TeamMode,
} from '@nvs/shared';
import { z } from 'zod';
import { ForbiddenError, UnauthorizedError, ValidationError } from '../../../shared/kernel/errors.js';
import type { OperatorService } from '../application/operator-service.js';
import type { OperatorRow } from '../infrastructure/pg-operator-repository.js';

/** Pessoa da equipe que entrou (nome + PIN) por cima da sessão da empresa. Nunca vale como sessão da empresa. */
export const PERSON_COOKIE = 'nvs_person';
const PERSON_SECONDS = 12 * 3600;

export interface PersonToken {
  sub: string;
  tenantId: string;
  typ: 'person';
  mode: TeamMode;
}

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

/**
 * Pessoa da equipe logada nesta requisição (sempre da mesma empresa da sessão).
 * Usado por outros módulos (ex.: Supervisão Full) para saber quem bipou/carregou.
 */
export function readPerson(app: FastifyInstance, req: FastifyRequest): PersonToken {
  const raw = req.cookies[PERSON_COOKIE];
  if (!raw) throw new UnauthorizedError('Escolha seu nome e digite o PIN');
  let t: PersonToken;
  try {
    t = app.jwt.verify<PersonToken>(raw);
  } catch {
    throw new UnauthorizedError('Sessão expirada: entre de novo com o PIN');
  }
  if (t.typ !== 'person' || t.tenantId !== req.user.tenantId) throw new UnauthorizedError('Sessão inválida');
  return t;
}

export function operationRoutes(service: OperatorService, opts: { secureCookies: boolean; tenantName: (id: string) => Promise<string> }) {
  return async (app: FastifyInstance) => {
    const auth = { preHandler: app.authenticate };
    const sign = (t: PersonToken) =>
      // papel mínimo (viewer) + typ: o authenticate da empresa recusa tokens com typ
      app.jwt.sign({ sub: t.sub, tenantId: t.tenantId, role: 'viewer', typ: t.typ, mode: t.mode }, { expiresIn: PERSON_SECONDS });
    const person = (req: FastifyRequest) => readPerson(app, req);
    /** Só MASTER (conferido no banco: tirar o MASTER vale na hora). */
    const master = async (req: FastifyRequest) => {
      const t = person(req);
      const op = await service.me(t.tenantId, t.sub);
      if (!op.is_master) throw new ForbiddenError('Só um MASTER pode cadastrar a equipe.');
    };
    const asMaster = { preHandler: [app.authenticate, master] };
    const session = (op: OperatorRow, mode: TeamMode): PersonSessionDto => ({
      person: { id: op.id, name: op.name, area: op.area, master: op.is_master, defaultPin: op.must_change_pin },
      mode,
    });
    const clear = (reply: FastifyReply) => reply.clearCookie(PERSON_COOKIE, { path: '/' });

    // ---- Entrada (sessão da empresa já aberta)
    app.get('/team', auth, async (req): Promise<TeamDto> => service.team(req.user.tenantId, await opts.tenantName(req.user.tenantId)));

    /** Equipe inicial de contas antigas (sem MASTER): quem tem a sessão da empresa cadastra. */
    app.post('/team/setup', { preHandler: app.requirePermission('operators:manage') }, async (req, reply) => {
      await service.setup(req.user.tenantId, req.user.sub, parse(teamSetupSchema, req.body));
      return reply.code(204).send();
    });

    app.post('/team/login', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const { operatorId, pin, mode } = parse(pinLoginSchema, req.body);
      const op = await service.login(req.user.tenantId, operatorId, pin, mode);
      reply.setCookie(PERSON_COOKIE, sign({ sub: op.id, tenantId: req.user.tenantId, typ: 'person', mode }), {
        httpOnly: true,
        sameSite: 'strict',
        secure: opts.secureCookies,
        path: '/',
        maxAge: PERSON_SECONDS,
      });
      return session(op, mode);
    });

    app.get('/team/me', auth, async (req, reply) => {
      const t = person(req);
      const op = await service.me(t.tenantId, t.sub).catch((err) => {
        clear(reply);
        throw err;
      });
      if (!areaAllows(op.area, t.mode)) {
        clear(reply);
        throw new UnauthorizedError('Seu acesso mudou: entre de novo');
      }
      return session(op, t.mode);
    });

    app.post('/team/pin', { preHandler: app.authenticate, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const t = person(req);
      const { current, next } = parse(changePinSchema, req.body);
      return session(await service.changePin(t.tenantId, t.sub, current, next), t.mode);
    });

    app.post('/team/logout', async (_req, reply) => {
      clear(reply);
      return reply.code(204).send();
    });

    // ---- Cadastro da equipe (MASTER, na Análise ou na Operação)
    const idParam = (req: FastifyRequest) => parse(z.object({ id: z.string().uuid() }), req.params).id;
    app.get('/team/members', asMaster, async (req) => service.list(req.user.tenantId));
    app.post('/team/members', asMaster, async (req, reply) =>
      reply.code(201).send(await service.create(req.user.tenantId, parse(createOperatorSchema, req.body))),
    );
    app.patch('/team/members/:id', asMaster, async (req) => service.update(req.user.tenantId, idParam(req), parse(updateOperatorSchema, req.body)));
    app.post('/team/members/:id/reset-pin', asMaster, async (req, reply) => {
      await service.resetPin(req.user.tenantId, idParam(req));
      return reply.code(204).send();
    });
  };
}
