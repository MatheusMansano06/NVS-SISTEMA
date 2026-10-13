import type { FastifyInstance } from 'fastify';
import { saveOnboardingSchema, saveTourSchema, tourIdSchema, type OnboardingDto, type ToursDto } from '@nvs/shared';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { OnboardingProgress } from '../domain/onboarding.js';
import type { OnboardingService } from '../application/onboarding-service.js';

const toDto = (p: OnboardingProgress): OnboardingDto => ({
  step: p.step,
  marketplace: p.marketplace,
  completed: p.completedAt !== null,
});

export function onboardingRoutes(service: OnboardingService) {
  return async (app: FastifyInstance) => {
    app.get('/onboarding', { preHandler: app.authenticate }, async (req) =>
      toDto(await service.get(req.user.tenantId, req.user.sub)),
    );

    // tours guiados: cada usuário vê uma vez por tela (pode rever quando quiser)
    app.get('/tours', { preHandler: app.authenticate }, async (req): Promise<ToursDto> => ({
      seen: await service.seenTours(req.user.tenantId, req.user.sub),
    }));

    app.put('/tours/:id', { preHandler: app.authenticate }, async (req, reply) => {
      const id = tourIdSchema.safeParse((req.params as { id?: string }).id);
      const body = saveTourSchema.safeParse(req.body);
      if (!id.success || !body.success) throw new ValidationError('Dados inválidos');
      await service.saveTour(req.user.tenantId, req.user.sub, id.data, body.data.status);
      return reply.code(204).send();
    });

    app.put('/onboarding', { preHandler: app.authenticate }, async (req) => {
      const parsed = saveOnboardingSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
      return toDto(await service.save(req.user.tenantId, req.user.sub, parsed.data));
    });
  };
}
