import type { FastifyInstance, FastifyRequest } from 'fastify';
import { abcQuerySchema } from '@nvs/shared';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { AbcCurveService } from '../application/abc-curve-service.js';

/** Curva ABC: classificação A/B/C dos anúncios por faturamento e por unidades. */
export function abcCurveRoutes(service: AbcCurveService) {
  return async (app: FastifyInstance) => {
    const enabled = async (req: FastifyRequest) => service.ensureFeature(req.user.tenantId);
    app.get('/sales/abc', { preHandler: [app.requirePermission('dashboard:read'), enabled] }, async (req) => {
      const parsed = abcQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('Período inválido', parsed.error.flatten());
      return service.curve(req.user.tenantId, parsed.data.period);
    });
  };
}
