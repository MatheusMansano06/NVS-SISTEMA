import type { SaveOnboardingInput } from '@nvs/shared';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { EventBus } from '../../../shared/kernel/event-bus.js';
import type { Database } from '../../../shared/infrastructure/database.js';
import { INITIAL_PROGRESS, type OnboardingProgress } from '../domain/onboarding.js';
import type { PgOnboardingRepository } from '../infrastructure/pg-onboarding-repository.js';

export class OnboardingService {
  constructor(
    private readonly db: Database,
    private readonly repo: PgOnboardingRepository,
    private readonly events: EventBus,
  ) {}

  get(tenantId: string, userId: string): Promise<OnboardingProgress> {
    return this.db.withTenant(tenantId, async (db) => (await this.repo.find(db, userId)) ?? INITIAL_PROGRESS);
  }

  /** Salva o passo atual (permite retomar de onde parou). Concluir exige plataforma escolhida. */
  async save(tenantId: string, userId: string, input: SaveOnboardingInput): Promise<OnboardingProgress> {
    const progress = await this.db.withTenant(tenantId, async (db) => {
      const current = (await this.repo.find(db, userId)) ?? INITIAL_PROGRESS;
      if (current.completedAt) return current; // concluído não volta atrás
      const marketplace = input.marketplace ?? current.marketplace;
      if ((input.step === 'authorize' || input.step === 'done') && !marketplace) {
        throw new ValidationError('Escolha uma plataforma para continuar', {
          fieldErrors: { marketplace: ['Escolha uma plataforma'] },
        });
      }
      const next: OnboardingProgress = {
        step: input.step,
        marketplace,
        completedAt: input.step === 'done' ? new Date() : null,
      };
      await this.repo.upsert(db, tenantId, userId, next);
      return next;
    });
    if (input.step === 'done' && progress.completedAt) {
      this.events.publish({
        type: 'onboarding.completed',
        tenantId,
        payload: { userId, marketplace: progress.marketplace },
      });
    }
    return progress;
  }
}
