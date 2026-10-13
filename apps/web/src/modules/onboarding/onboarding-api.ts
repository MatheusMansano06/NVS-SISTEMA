import type { OnboardingDto, SaveOnboardingInput } from '@nvs/shared';
import { http } from '../../shared/http';

export const onboardingApi = {
  get: () => http<OnboardingDto>('/api/v1/onboarding'),
  save: (input: SaveOnboardingInput) =>
    http<OnboardingDto>('/api/v1/onboarding', { method: 'PUT', body: input }),
};
