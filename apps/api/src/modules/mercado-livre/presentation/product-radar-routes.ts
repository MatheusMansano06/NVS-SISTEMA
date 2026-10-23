import type { FastifyInstance, FastifyRequest } from 'fastify';
import { productRadarProductSchema } from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { ProductRadarQueries } from '../application/product-radar-queries.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const dayQuery = z.object({ day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional() });
const idParam = z.object({ id: z.string().uuid() });

/** Produto Campeão: ranking do dia e gravação dos estudos do agente de viabilidade. */
export function productRadarRoutes(queries: ProductRadarQueries) {
  return async (app: FastifyInstance) => {
    const enabled = async (req: FastifyRequest) => queries.ensureFeature(req.user.tenantId);
    const read = { preHandler: [app.requirePermission('dashboard:read'), enabled] };
    const write = { preHandler: [app.requirePermission('listings:manage'), enabled] };

    app.get('/product-radar', read, async (req) => queries.day(req.user.tenantId, parse(dayQuery, req.query).day));
    // o agente grava cada produto assim que termina de estudar (mesma busca no mesmo dia substitui)
    app.post('/product-radar/products', write, async (req, reply) =>
      reply.code(201).send(await queries.save(req.user.tenantId, req.user.sub, parse(productRadarProductSchema, req.body))),
    );
    app.delete('/product-radar/products/:id', write, async (req, reply) => {
      await queries.remove(req.user.tenantId, parse(idParam, req.params).id);
      return reply.code(204).send();
    });
  };
}
