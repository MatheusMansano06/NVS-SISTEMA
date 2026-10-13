import { useEffect, useState } from 'react';
import type { OnboardingDto } from '@nvs/shared';
import { AuthProvider, useAuth } from './modules/auth/AuthContext';
import { AuthPage } from './modules/auth/AuthPage';
import { Dashboard } from './modules/dashboard/Dashboard';
import { OnboardingPage } from './modules/onboarding/OnboardingPage';
import { onboardingApi } from './modules/onboarding/onboarding-api';
import { SkuPage } from './modules/skus/SkuPage';
import { ListingsPage } from './modules/listings/ListingsPage';
import { PromotionsPage } from './modules/listings/PromotionsPage';
import { SalesPage } from './modules/sales/SalesPage';
import { PricingPage } from './modules/pricing/PricingPage';
import { FreightPage } from './modules/freight/FreightPage';
import { FinancePage } from './modules/finance/FinancePage';
import { usePath } from './app/router';
import type { StationDto } from '@nvs/shared';
import { ModeSelect } from './modules/operation/ModeSelect';
import { OperatorsPage } from './modules/operation/OperatorsPage';
import { StationApp } from './modules/operation/StationApp';
import { operationApi } from './modules/operation/operation-api';

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
  if (path.startsWith('/vendas')) return <SalesPage />;
  if (path.startsWith('/precificador')) return <PricingPage />;
  if (path.startsWith('/radar-frete')) return <FreightPage />;
  if (path.startsWith('/operadores')) return <OperatorsPage />;
  if (path.startsWith('/anuncios/promocoes')) return <PromotionsPage />;
  if (path.startsWith('/anuncios')) return <ListingsPage />;
  if (path.startsWith('/financeiro')) return <FinancePage />;
  return <Dashboard />;
}

function SignedIn({ userName }: { userName: string }) {
  const [onboarding, setOnboarding] = useState<OnboardingDto | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    onboardingApi.get().then(setOnboarding).catch(() => setFailed(true));
  }, []);

  if (failed) return <Analysis />; // falha ao consultar não deve trancar o usuário fora
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
  return <Analysis />;
}

const MODE_KEY = 'nvs:mode';

/** Logo após entrar: escolher Análise ou Operação (uma vez por aba do navegador). */
function Analysis() {
  const [chosen, setChosen] = useState(() => {
    try {
      return sessionStorage.getItem(MODE_KEY) === 'analysis';
    } catch {
      return true;
    }
  });
  if (chosen) return <Pages />;
  return (
    <ModeSelect
      onAnalysis={() => {
        try {
          sessionStorage.setItem(MODE_KEY, 'analysis');
        } catch {
          /* sem storage: segue */
        }
        setChosen(true);
      }}
    />
  );
}

/** Sem sessão de analista: se este computador é da Operação, abre a estação; senão, login. */
function SignedOut() {
  const [station, setStation] = useState<StationDto | null | undefined>(undefined);
  useEffect(() => {
    operationApi.station().then(setStation).catch(() => setStation(null));
  }, []);
  if (station === undefined) return <Boot />;
  if (station) return <StationApp initial={station} />;
  try {
    sessionStorage.removeItem(MODE_KEY); // próximo login pergunta o modo de novo
  } catch {
    /* sem storage */
  }
  return <AuthPage />;
}

function Router() {
  const { session, loading } = useAuth();
  if (loading) return <Boot />;
  if (!session) return <SignedOut />;
  return <SignedIn key={session.user.id} userName={session.user.name} />;
}

export function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
