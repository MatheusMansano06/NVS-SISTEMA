import type { Marketplace, OnboardingStep } from '@nvs/shared';

export interface OnboardingProgress {
  step: OnboardingStep;
  marketplace: Marketplace | null;
  completedAt: Date | null;
}

export const INITIAL_PROGRESS: OnboardingProgress = {
  step: 'welcome',
  marketplace: null,
  completedAt: null,
};
