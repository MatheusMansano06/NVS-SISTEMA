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
import { AppShell } from './app/AppShell';
import { FullRouter } from './modules/full/FullRouter';
import type { PersonSessionDto, TeamDto } from '@nvs/shared';
import { OperationApp } from './modules/operation/OperationApp';
import { PersonProvider } from './modules/operation/PersonContext';
import { PinChange } from './modules/operation/PinChange';
import { TeamEntry } from './modules/operation/TeamEntry';
import { TeamPage } from './modules/operation/TeamPage';
import { TeamSetup } from './modules/operation/TeamSetup';
import { teamApi } from './modules/operation/operation-api';
import './modules/operation/operation.css';

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
  if (path.startsWith('/equipe')) return <TeamPage />;
  if (path.startsWith('/full')) return <AppShell><FullRouter mode="analise" /></AppShell>;
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

/**
 * Depois do login da empresa: equipe cadastrada? → Análise ou Operação → nome → PIN.
 * Quem ainda usa o PIN 1234 recebe o convite (opcional) para criar o seu.
 */
function TeamGate({ userName }: { userName: string }) {
  const [team, setTeam] = useState<TeamDto | null>(null);
  const [person, setPerson] = useState<PersonSessionDto | null | undefined>(undefined);
  const [offerPin, setOfferPin] = useState(false);
  const [failed, setFailed] = useState(false);

  const load = () => {
    teamApi.team().then(setTeam).catch(() => setFailed(true));
    teamApi.me().then(setPerson).catch(() => setPerson(null));
  };
  useEffect(load, []);

  if (failed) return <p className="banner banner-error boot-error">Não foi possível carregar a equipe. Recarregue a página.</p>;
  if (!team || person === undefined) return <Boot />;
  if (team.setupNeeded) return <TeamSetup team={team} onDone={() => { setTeam(null); load(); }} />;
  if (!person) {
    return (
      <TeamEntry
        team={team}
        onEnter={(p) => {
          setPerson(p);
          setOfferPin(p.person.defaultPin);
        }}
      />
    );
  }
  const ctx = {
    person,
    update: setPerson,
    switchPerson: () => {
      void teamApi.logout();
      setPerson(null);
      setOfferPin(false);
      teamApi.team().then(setTeam).catch(() => undefined);
    },
  };
  return (
    <PersonProvider value={ctx}>
      {offerPin ? (
        <div className="station">
          <main className="station-main">
            <div className="pin-offer">
              <p className="ledit-hint">Você está usando o PIN padrão <b>1234</b>. Quer criar um só seu? É opcional.</p>
              <PinChange person={person} onCancel={() => setOfferPin(false)} onDone={(p) => { setPerson(p); setOfferPin(false); }} />
            </div>
          </main>
        </div>
      ) : person.mode === 'operacao' ? (
        <OperationApp />
      ) : (
        <SignedIn userName={userName} />
      )}
    </PersonProvider>
  );
}

function Router() {
  const { session, loading } = useAuth();
  if (loading) return <Boot />;
  if (!session) return <AuthPage />;
  return <TeamGate key={session.user.id} userName={session.user.name} />;
}

export function App() {
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
