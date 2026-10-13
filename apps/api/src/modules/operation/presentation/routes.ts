import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  changePinSchema,
  createOperatorSchema,
  pinLoginSchema,
  updateOperatorSchema,
  type OperatorSessionDto,
  type StationDto,
} from '@nvs/shared';
import { z } from 'zod';
import { UnauthorizedError, ValidationError } from '../../../shared/kernel/errors.js';
import type { OperatorService } from '../application/operator-service.js';
import type { OperatorRow } from '../infrastructure/pg-operator-repository.js';

/** Computador em modo Operação (lista os operadores). Cookie próprio: nunca vale como sessão da Análise. */
export const STATION_COOKIE = 'nvs_station';
/** Operador logado. */
export const OPERATOR_COOKIE = 'nvs_op';
const SESSION_COOKIE = 'nvs_session';
const STATION_SECONDS = 90 * 24 * 3600;
const OPERATOR_SECONDS = 12 * 3600;

interface OpToken {
  sub: string;
  tenantId: string;
  typ: 'station' | 'operator';
}

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

export function operationRoutes(service: OperatorService, opts: { secureCookies: boolean; tenantName: (id: string) => Promise<string> }) {
  return async (app: FastifyInstance) => {
    const manage = { preHandler: app.requirePermission('operators:manage') };
    const cookie = (reply: FastifyReply, name: string, value: string, seconds: number) =>
      reply.setCookie(name, value, { httpOnly: true, sameSite: 'strict', secure: opts.secureCookies, path: '/', maxAge: seconds });
    const sign = (t: OpToken, seconds: number) =>
      // papel mínimo (viewer) + typ: o authenticate da Análise recusa tokens com typ
      app.jwt.sign({ sub: t.sub, tenantId: t.tenantId, role: 'viewer', typ: t.typ }, { expiresIn: seconds });
    const read = (req: FastifyRequest, name: string, typ: OpToken['typ']): OpToken => {
      const raw = req.cookies[name];
      if (!raw) throw new UnauthorizedError('Sessão ausente');
      try {
        const t = app.jwt.verify<OpToken>(raw);
        if (t.typ !== typ) throw new Error('tipo');
        return t;
      } catch {
        throw new UnauthorizedError('Sessão inválida');
      }
    };
    const session = async (op: OperatorRow, tenantId: string): Promise<OperatorSessionDto> => ({
      operator: { id: op.id, name: op.name, mustChangePin: op.must_change_pin },
      tenant: { id: tenantId, name: await opts.tenantName(tenantId) },
    });

    // ---- Cadastro (Análise)
    app.get('/operators', manage, async (req) => service.list(req.user.tenantId));
    app.post('/operators', manage, async (req, reply) =>
      reply.code(201).send(await service.create(req.user.tenantId, req.user.sub, parse(createOperatorSchema, req.body).name)),
    );
    app.patch('/operators/:id', manage, async (req) =>
      service.update(req.user.tenantId, parse(z.object({ id: z.string().uuid() }), req.params).id, parse(updateOperatorSchema, req.body)),
    );
    app.post('/operators/:id/reset-pin', manage, async (req, reply) => {
      await service.resetPin(req.user.tenantId, parse(z.object({ id: z.string().uuid() }), req.params).id);
      return reply.code(204).send();
    });

    // ---- Computador da operação
    /** A Análise coloca este computador em modo Operação: encerra a sessão da Análise aqui. */
    app.post('/station/start', manage, async (req, reply) => {
      cookie(reply, STATION_COOKIE, sign({ sub: req.user.sub, tenantId: req.user.tenantId, typ: 'station' }, STATION_SECONDS), STATION_SECONDS);
      reply.clearCookie(SESSION_COOKIE, { path: '/' });
      return reply.code(204).send();
    });

    app.get('/station', async (req): Promise<StationDto> => {
      const st = read(req, STATION_COOKIE, 'station');
      return { tenant: { name: await opts.tenantName(st.tenantId) }, operators: await service.station(st.tenantId) };
    });

    app.post('/station/login', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req, reply) => {
      const st = read(req, STATION_COOKIE, 'station');
      const { operatorId, pin } = parse(pinLoginSchema, req.body);
      const op = await service.login(st.tenantId, operatorId, pin);
      cookie(reply, OPERATOR_COOKIE, sign({ sub: op.id, tenantId: st.tenantId, typ: 'operator' }, OPERATOR_SECONDS), OPERATOR_SECONDS);
      return session(op, st.tenantId);
    });

    /** Sai do modo Operação (para voltar à Análise é preciso entrar de novo com e-mail e senha). */
    app.post('/station/exit', async (_req, reply) => {
      reply.clearCookie(STATION_COOKIE, { path: '/' }).clearCookie(OPERATOR_COOKIE, { path: '/' });
      return reply.code(204).send();
    });

    // ---- Operador logado
    app.get('/operator/me', async (req) => {
      const t = read(req, OPERATOR_COOKIE, 'operator');
      return session(await service.me(t.tenantId, t.sub), t.tenantId);
    });
    app.post('/operator/pin', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
      const t = read(req, OPERATOR_COOKIE, 'operator');
      const { current, next } = parse(changePinSchema, req.body);
      return session(await service.changePin(t.tenantId, t.sub, current, next), t.tenantId);
    });
    app.post('/operator/logout', async (_req, reply) => {
      reply.clearCookie(OPERATOR_COOKIE, { path: '/' });
      return reply.code(204).send();
    });
  };
}
