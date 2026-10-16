import { lazy, Suspense, useEffect, useState, type ComponentType, type ReactNode } from 'react';
import type { OnboardingDto, TenantFeature } from '@nvs/shared';
import { AuthProvider, useAuth } from './modules/auth/AuthContext';
import { AuthPage } from './modules/auth/AuthPage';
import { Dashboard } from './modules/dashboard/Dashboard';
import { OnboardingPage } from './modules/onboarding/OnboardingPage';
import { onboardingApi } from './modules/onboarding/onboarding-api';
import { usePath } from './app/router';
import { AppShell } from './app/AppShell';
import { FeatureGate, useFeatures } from './shared/features';
import type { PersonSessionDto, TeamDto } from '@nvs/shared';
import { PersonProvider } from './modules/operation/PersonContext';
import { PinChange } from './modules/operation/PinChange';
import { TeamEntry } from './modules/operation/TeamEntry';
import { TeamSetup } from './modules/operation/TeamSetup';
import { teamApi } from './modules/operation/operation-api';
import './modules/operation/operation.css';

/** Tela carregada só quando aberta: o Dashboard (tela inicial) não espera o código do resto do sistema. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function page<K extends string>(load: () => Promise<Record<K, ComponentType<any>>>, name: K) {
  return lazy(() => load().then((m) => ({ default: m[name] })));
}
const SkuPage = page(() => import('./modules/skus/SkuPage'), 'SkuPage');
const ListingsPage = page(() => import('./modules/listings/ListingsPage'), 'ListingsPage');
const PromotionsPage = page(() => import('./modules/listings/PromotionsPage'), 'PromotionsPage');
const MarketingPage = page(() => import('./modules/listings/MarketingPage'), 'MarketingPage');
const SalesPage = page(() => import('./modules/sales/SalesPage'), 'SalesPage');
const PricingPage = page(() => import('./modules/pricing/PricingPage'), 'PricingPage');
const FreightPage = page(() => import('./modules/freight/FreightPage'), 'FreightPage');
const FinancePage = page(() => import('./modules/finance/FinancePage'), 'FinancePage');
const DrePage = page(() => import('./modules/dre/DrePage'), 'DrePage');
const FullRouter = page(() => import('./modules/full/FullRouter'), 'FullRouter');
const CentralDevolucoes = page(() => import('./modules/central/CentralDevolucoes'), 'CentralDevolucoes');
const OperationApp = page(() => import('./modules/operation/OperationApp'), 'OperationApp');
const TeamPage = page(() => import('./modules/operation/TeamPage'), 'TeamPage');
const MasterApp = page(() => import('./modules/master/MasterApp'), 'MasterApp');

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
  return (
    <Suspense fallback={<Boot />}>
      <Routes />
    </Suspense>
  );
}

/** Telas que dependem de recurso liberado para a empresa (Painel Master / plano). */
const GATED: { prefix: string; feature: TenantFeature; page: () => ReactNode }[] = [
  { prefix: '/vendas', feature: 'vendas', page: () => <SalesPage /> },
  { prefix: '/precificador', feature: 'precificador', page: () => <PricingPage /> },
  { prefix: '/radar-frete', feature: 'radar_frete', page: () => <FreightPage /> },
  { prefix: '/devolucoes', feature: 'devolucoes', page: () => <CentralDevolucoes /> },
  { prefix: '/full', feature: 'full', page: () => <FullRouter mode="analise" /> },
  { prefix: '/anuncios/promocoes', feature: 'promocoes', page: () => <PromotionsPage /> },
  { prefix: '/anuncios/marketing', feature: 'marketing', page: () => <MarketingPage /> },
  { prefix: '/anuncios', feature: 'anuncios', page: () => <ListingsPage /> },
  { prefix: '/financeiro', feature: 'financeiro', page: () => <FinancePage /> },
  { prefix: '/dre', feature: 'financeiro', page: () => <DrePage /> },
];
/** Telas que já trazem o AppShell próprio (as demais são embrulhadas aqui). */
const OWN_SHELL = new Set(['/vendas', '/precificador', '/radar-frete', '/anuncios/promocoes', '/anuncios/marketing', '/anuncios', '/financeiro', '/dre']);

function Routes() {
  const path = usePath();
  const features = useFeatures();
  if (path.startsWith('/skus')) return <SkuPage />;
  if (path.startsWith('/equipe')) return <TeamPage />;
  const g = GATED.find((x) => path.startsWith(x.prefix));
  if (g) {
    if (!features.includes(g.feature)) return <AppShell><FeatureGate feature={g.feature}>{null}</FeatureGate></AppShell>;
    return OWN_SHELL.has(g.prefix) ? <>{g.page()}</> : <AppShell>{g.page()}</AppShell>;
  }
  return <Dashboard />;
}

function SignedIn({ userName, initial = null }: { userName: string; initial?: OnboardingDto | null }) {
  const [onboarding, setOnboarding] = useState<OnboardingDto | null>(initial);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!initial) onboardingApi.get().then(setOnboarding).catch(() => setFailed(true));
  }, [initial]);

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
 * Primeiro acesso (passo a passo da Gertrudez ainda não concluído): vai direto para a integração;
 * a escolha Análise/Operação só aparece nos acessos seguintes.
 * Quem ainda usa o PIN 1234 recebe o convite (opcional) para criar o seu.
 */
function TeamGate({ userName }: { userName: string }) {
  const [team, setTeam] = useState<TeamDto | null>(null);
  const [person, setPerson] = useState<PersonSessionDto | null | undefined>(undefined);
  const [onboarding, setOnboarding] = useState<OnboardingDto | null | undefined>(undefined);
  const [offerPin, setOfferPin] = useState(false);
  const [failed, setFailed] = useState(false);
  // decidido uma vez: concluir o passo a passo nesta sessão não joga a pessoa de volta para a escolha
  const [firstAccess, setFirstAccess] = useState<boolean | undefined>(undefined);

  const load = () => {
    teamApi.team().then(setTeam).catch(() => setFailed(true));
    teamApi.me().then(setPerson).catch(() => setPerson(null));
  };
  useEffect(load, []);
  useEffect(() => {
    onboardingApi.get().then(setOnboarding).catch(() => setOnboarding(null));
  }, []);
  useEffect(() => {
    if (firstAccess === undefined && onboarding !== undefined) setFirstAccess(onboarding ? !onboarding.completed : false);
  }, [onboarding, firstAccess]);

  if (failed) return <p className="banner banner-error boot-error">Não foi possível carregar a equipe. Recarregue a página.</p>;
  if (!team || person === undefined || firstAccess === undefined) return <Boot />;
  if (team.setupNeeded) return <TeamSetup team={team} onDone={() => { setTeam(null); load(); }} />;
  if (!person && firstAccess) return <SignedIn userName={userName} initial={onboarding} />;
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
        <Suspense fallback={<Boot />}>
          <OperationApp />
        </Suspense>
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
  const path = usePath();
  // Painel Master (dono do NVS Tech): login e sessão próprios, fora do fluxo das empresas
  if (path.startsWith('/master')) {
    return (
      <Suspense fallback={<Boot />}>
        <MasterApp />
      </Suspense>
    );
  }
  return (
    <AuthProvider>
      <Router />
    </AuthProvider>
  );
}
