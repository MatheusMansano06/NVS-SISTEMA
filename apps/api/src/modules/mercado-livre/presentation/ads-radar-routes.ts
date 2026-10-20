import type { FastifyInstance, FastifyRequest } from 'fastify';
import { adGoalInputSchema, adRuleInputSchema, adSimulateSchema } from '@nvs/shared';
import { z } from 'zod';
import { AppError, ValidationError } from '../../../shared/kernel/errors.js';
import type { AdsRadarQueries } from '../application/ads-radar-queries.js';
import type { AdsRadarService } from '../application/ads-radar-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const idParam = z.object({ id: z.string().uuid() });
const campaignParams = z.object({ accountId: z.string().uuid(), campaignId: z.coerce.number().int().positive() });
const eventsQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
const readBody = z.object({ ids: z.array(z.string().uuid()).max(500).nullable().default(null) });

/** Radar ADS: visão da conta, campanhas, regras, metas e alertas do Mercado Ads. */
export function adsRadarRoutes(queries: AdsRadarQueries, service: AdsRadarService | null) {
  return async (app: FastifyInstance) => {
    const enabled = async (req: FastifyRequest) => queries.ensureFeature(req.user.tenantId);
    const read = { preHandler: [app.requirePermission('dashboard:read'), enabled] };
    const write = { preHandler: [app.requirePermission('listings:manage'), enabled] };
    const tenant = (req: FastifyRequest) => req.user.tenantId;

    app.get('/ads-radar/overview', read, async (req) => queries.overview(tenant(req)));
    app.get('/ads-radar/campaigns', read, async (req) => queries.campaigns(tenant(req)));
    app.get('/ads-radar/campaigns/:accountId/:campaignId', read, async (req) => {
      const p = parse(campaignParams, req.params);
      return queries.campaign(tenant(req), p.accountId, p.campaignId);
    });

    app.get('/ads-radar/rules', read, async (req) => queries.rules(tenant(req)));
    app.post('/ads-radar/rules', write, async (req, reply) =>
      reply.code(201).send(await queries.createRule(tenant(req), req.user.sub, parse(adRuleInputSchema, req.body))),
    );
    app.put('/ads-radar/rules/:id', write, async (req, reply) => {
      await queries.updateRule(tenant(req), parse(idParam, req.params).id, parse(adRuleInputSchema, req.body));
      return reply.code(204).send();
    });
    app.delete('/ads-radar/rules/:id', write, async (req, reply) => {
      await queries.deleteRule(tenant(req), parse(idParam, req.params).id);
      return reply.code(204).send();
    });
    // simular só lê: quem vê o Radar pode testar uma regra antes de pedir para salvar
    app.post('/ads-radar/rules/simulate', read, async (req) => queries.simulate(tenant(req), parse(adSimulateSchema, req.body)));

    app.get('/ads-radar/goals', read, async (req) => queries.goals(tenant(req)));
    app.put('/ads-radar/goals', write, async (req) => queries.saveGoal(tenant(req), req.user.sub, parse(adGoalInputSchema, req.body)));
    app.delete('/ads-radar/goals/:id', write, async (req, reply) => {
      await queries.deleteGoal(tenant(req), parse(idParam, req.params).id);
      return reply.code(204).send();
    });

    app.get('/ads-radar/events', read, async (req) => queries.events(tenant(req), parse(eventsQuery, req.query).limit));
    app.post('/ads-radar/events/read', read, async (req, reply) => {
      await queries.markRead(tenant(req), parse(readBody, req.body ?? {}).ids);
      return reply.code(204).send();
    });

    /** Atualizar agora: lê as métricas e avalia as regras em segundo plano. */
    app.post('/ads-radar/sync', write, async (req, reply) => {
      if (!service) throw new AppError('A integração com o Mercado Livre não está configurada.', 'ML_NOT_CONFIGURED', 503);
      const tenantId = tenant(req);
      void service
        .syncTenant(tenantId)
        .then(() => service.evaluate(tenantId))
        .catch((err) => req.log.error({ err, tenantId }, 'Radar ADS: atualização manual falhou'));
      return reply.code(202).send({ started: true });
    });
  };
}
