import type { FastifyInstance } from 'fastify';
import { saveOnboardingSchema, type OnboardingDto } from '@nvs/shared';
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

    app.put('/onboarding', { preHandler: app.authenticate }, async (req) => {
      const parsed = saveOnboardingSchema.safeParse(req.body);
      if (!parsed.success) throw new ValidationError('Dados inválidos', parsed.error.flatten());
      return toDto(await service.save(req.user.tenantId, req.user.sub, parsed.data));
    });
  };
}
