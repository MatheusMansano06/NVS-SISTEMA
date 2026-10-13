import { useEffect, useState } from 'react';
import type { OnboardingDto } from '@nvs/shared';
import { AuthProvider, useAuth } from './modules/auth/AuthContext';
import { AuthPage } from './modules/auth/AuthPage';
import { Dashboard } from './modules/dashboard/Dashboard';
import { OnboardingPage } from './modules/onboarding/OnboardingPage';
import { onboardingApi } from './modules/onboarding/onboarding-api';
import { SkuPage } from './modules/skus/SkuPage';
import { FinancePage } from './modules/finance/FinancePage';
import { usePath } from './app/router';

function Boot() {
  return (
    <div className="boot" role="status" aria-label="Carregando">
      <img src="/nvs-logo.webp" alt="" />
    </div>
  );
}

/** Usuário logado: passo a passo obrigatório até concluir; depois, o sistema. */
/** Páginas do sistema (após o passo a passo). */
function Pages() {
  const path = usePath();
  if (path.startsWith('/skus')) return <SkuPage />;
  if (path.startsWith('/financeiro')) return <FinancePage />;
  return <Dashboard />;
}

function SignedIn({ userName }: { userName: string }) {
  const [onboarding, setOnboarding] = useState<OnboardingDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onboardingApi.get().then(setOnboarding).catch(() => setFailed(true));
  }, []);

  if (failed) return <Pages />; // falha ao consultar não deve trancar o usuário fora
  if (!onboarding) return <Boot />;
  if (!onboarding.completed) {
    return (
      <OnboardingPage
        initial={onboarding}
        userName={userName}
        onFinish={() => setOnboarding({ ...onboarding, step: 'done', completed: true })}
      />
    );
  }
  return <Pages />;
}

function Router() {
  const { session, loading } = useAuth();
  if (loading) return <Boot />;
  if (!session) return <AuthPage />;
  return <SignedIn key={session.user.id} userName={session.user.name} />;
}

export function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
