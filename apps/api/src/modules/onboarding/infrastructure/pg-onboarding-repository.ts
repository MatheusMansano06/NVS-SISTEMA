import type { Marketplace, OnboardingStep } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import type { OnboardingProgress } from '../domain/onboarding.js';

interface Row {
  step: OnboardingStep;
  marketplace: Marketplace | null;
  completed_at: Date | null;
}

export class PgOnboardingRepository {
  async find(db: Queryable, userId: string): Promise<OnboardingProgress | null> {
    const { rows } = await db.query<Row>(
      'SELECT step, marketplace, completed_at FROM onboarding_progress WHERE user_id = $1',
      [userId],
    );
    const r = rows[0];
    return r ? { step: r.step, marketplace: r.marketplace, completedAt: r.completed_at } : null;
  }

  async upsert(db: Queryable, tenantId: string, userId: string, p: OnboardingProgress): Promise<void> {
    await db.query(
      `INSERT INTO onboarding_progress (user_id, tenant_id, step, marketplace, completed_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (user_id) DO UPDATE
         SET step = EXCLUDED.step, marketplace = EXCLUDED.marketplace,
             completed_at = EXCLUDED.completed_at, updated_at = now()`,
      [userId, tenantId, p.step, p.marketplace, p.completedAt],
    );
  }

  async seenTours(db: Queryable, userId: string): Promise<string[]> {
    const { rows } = await db.query<{ tour_id: string }>('SELECT tour_id FROM user_tours WHERE user_id = $1', [userId]);
    return rows.map((r) => r.tour_id);
  }

  async saveTour(db: Queryable, tenantId: string, userId: string, tourId: string, status: 'done' | 'skipped'): Promise<void> {
    await db.query(
      `INSERT INTO user_tours (user_id, tenant_id, tour_id, status) VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, tour_id) DO UPDATE SET status = EXCLUDED.status, updated_at = now()`,
      [userId, tenantId, tourId, status],
    );
  }
}
