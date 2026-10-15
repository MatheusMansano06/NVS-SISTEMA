import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { ViabilityService } from '../application/viability-service.js';

const params = z.object({ id: z.string().trim().regex(/^MLB-?\d{6,15}$/i) });

/** Estudo de viabilidade (consumido pela extensão do Chrome). */
export function viabilityRoutes(service: ViabilityService | null) {
  return async (app: FastifyInstance) => {
    // cada consulta pode chamar o ML 3–4 vezes: limite por IP para não esgotar a cota da conta
    const live = { preHandler: app.requirePermission('dashboard:read'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

    app.get('/ml/viabilidade/:id', live, async (req) => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      const p = params.safeParse(req.params);
      if (!p.success) throw new ValidationError('Código de anúncio inválido (ex.: MLB1234567890)');
      return service.analyze(req.user.tenantId, p.data.id);
    });
  };
}
