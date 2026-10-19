import type { FastifyInstance } from 'fastify';
import { savePricingStudySchema } from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { PricingStudyService } from '../application/pricing-study-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const idParam = z.object({ id: z.string().uuid() });

/** Precificador › Viabilidade: não depende do Mercado Livre conectado (usa as tabelas fixas). */
export function pricingStudyRoutes(service: PricingStudyService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('listings:manage') };

    app.get('/pricing/studies', read, async (req) => service.list(req.user.tenantId));
    app.post('/pricing/studies', write, async (req) =>
      service.create(req.user.tenantId, req.user.sub, parse(savePricingStudySchema, req.body)),
    );
    app.put('/pricing/studies/:id', write, async (req) =>
      service.update(req.user.tenantId, parse(idParam, req.params).id, parse(savePricingStudySchema, req.body)),
    );
    app.delete('/pricing/studies/:id', write, async (req, reply) => {
      await service.remove(req.user.tenantId, parse(idParam, req.params).id);
      return reply.code(204).send();
    });
  };
}
