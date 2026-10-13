import type { FastifyInstance } from 'fastify';
import { pricingQuoteSchema, savePricingSimulationSchema } from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { PricingService } from '../application/pricing-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

/** Precificador: tarifas do ML para qualquer preço/categoria e simulações salvas. */
export function pricingRoutes(service: PricingService | null) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('listings:manage') };
    const need = () => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return service;
    };

    app.get('/pricing/quote', read, async (req) => {
      const { price, categoryId } = parse(pricingQuoteSchema, req.query);
      return need().quote(req.user.tenantId, price, categoryId);
    });
    app.get('/pricing/categories', read, async (req) =>
      need().categories(req.user.tenantId, parse(z.object({ q: z.string().trim().min(2).max(80) }), req.query).q),
    );
    app.get('/pricing/simulations', read, async (req) => need().simulations(req.user.tenantId));
    app.post('/pricing/simulations', write, async (req) =>
      need().save(req.user.tenantId, req.user.sub, parse(savePricingSimulationSchema, req.body)),
    );
    app.delete('/pricing/simulations/:id', write, async (req, reply) => {
      await need().remove(req.user.tenantId, parse(z.object({ id: z.string().uuid() }), req.params).id);
      return reply.code(204).send();
    });
  };
}
