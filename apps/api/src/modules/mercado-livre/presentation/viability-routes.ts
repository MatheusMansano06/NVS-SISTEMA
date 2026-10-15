import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { MAX_BATCH, type ViabilityService } from '../application/viability-service.js';

const mlbId = z.string().trim().regex(/^MLB-?\d{6,15}$/i);
const params = z.object({ id: mlbId });
const batch = z.object({ ids: z.string().transform((s) => s.split(',').filter(Boolean)).pipe(z.array(mlbId).min(1).max(MAX_BATCH)) });

/** Estudo de viabilidade (consumido pela extensão do Chrome). */
export function viabilityRoutes(service: ViabilityService | null) {
  return async (app: FastifyInstance) => {
    // cada consulta pode chamar o ML 3–4 vezes: limite por IP para não esgotar a cota da conta
    const live = { preHandler: app.requirePermission('dashboard:read'), config: { rateLimit: { max: 60, timeWindow: '1 minute' } } };

    // etiquetas da página de busca: ?ids=MLB1,MLB2,… (até 60)
    app.get('/ml/viabilidade', live, async (req) => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      const q = batch.safeParse(req.query);
      if (!q.success) throw new ValidationError(`Informe de 1 a ${MAX_BATCH} códigos de anúncio em ids (ex.: ids=MLB1234567890,MLB987654321)`);
      return service.analyzeMany(req.user.tenantId, q.data.ids);
    });

    // precisão da data estimada (medida nos anúncios da própria empresa)
    app.get('/ml/viabilidade/precisao', live, async (req) => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return service.accuracy(req.user.tenantId);
    });

    app.get('/ml/viabilidade/:id', live, async (req) => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      const p = params.safeParse(req.params);
      if (!p.success) throw new ValidationError('Código de anúncio inválido (ex.: MLB1234567890)');
      return service.analyze(req.user.tenantId, p.data.id);
    });
  };
}
