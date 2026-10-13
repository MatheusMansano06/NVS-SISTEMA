import { ONBOARDING_STEPS, type OnboardingStep } from '@nvs/shared';

const LABELS: Record<OnboardingStep, string> = {
  welcome: 'Boas-vindas',
  platform: 'Plataforma',
  authorize: 'Autorização',
  done: 'Pronto',
};

export function Progress({ step }: { step: OnboardingStep }) {
  const current = ONBOARDING_STEPS.indexOf(step);
  return (
    <nav className="onb-progress" aria-label={`Passo ${current + 1} de ${ONBOARDING_STEPS.length}`}>
      <ol>
        {ONBOARDING_STEPS.map((s, i) => (
          <li key={s} data-state={i < current ? 'done' : i === current ? 'current' : 'next'}>
            <span className="dot" aria-hidden="true" />
            <span className="label">{LABELS[s]}</span>
          </li>
        ))}
      </ol>
    </nav>
  );
}
