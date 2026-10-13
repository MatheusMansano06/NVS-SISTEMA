import { useCallback, useRef, useState } from 'react';
import { PERIOD_LABELS } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { useAuth } from '../auth/AuthContext';
import { int, money, pct } from '../../shared/format';
import { Button } from '../../shared/ui/Button';
import { FilterBar } from './components/FilterBar';
import { KpiCard } from './components/KpiCard';
import { MarginRing } from './components/MarginRing';
import { RevenueChart } from './components/RevenueChart';
import { Sparkline } from './components/Sparkline';
import { PausedCarousel } from './components/PausedCarousel';
import { TopFive } from './components/TopFive';
import type { DashboardFilters } from './dashboard-api';
import { useDashboard } from './useDashboard';
import { SyncProgress } from '../mercado-livre/SyncProgress';
import { consumeMlReturn } from '../mercado-livre/ml-api';
import { navigate } from '../../app/router';
import './dashboard.css';

const HIDE_KEY = 'nvs.hideValues';
const readHidden = () => {
  try {
    return localStorage.getItem(HIDE_KEY) === '1';
  } catch {
    return false;
  }
};

function greeting(): string {
  const h = new Date().getHours();
  return h < 12 ? 'Bom dia' : h < 18 ? 'Boa tarde' : 'Boa noite';
}

export function Dashboard() {
  const { session } = useAuth();
  const [filters, setFilters] = useState<DashboardFilters>({ period: 'today' });
  const [hidden, setHidden] = useState(readHidden);
  const { data, loading, error, refresh } = useDashboard(filters);
  const [mlReturn] = useState(consumeMlReturn);
  // referência estável: o acompanhamento da sincronização pede atualização a cada avanço
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const onSyncAdvance = useCallback(() => void refreshRef.current(), []);

  const toggleHidden = () =>
    setHidden((v) => {
      try {
        localStorage.setItem(HIDE_KEY, v ? '0' : '1');
      } catch {
        /* armazenamento indisponível: vale só para esta sessão */
      }
      return !v;
    });

  const name = session?.user.name ?? '';
  const k = data?.kpis;
  const p = data?.previous;

  return (
    <AppShell>
      <div className="dash" data-hidden={hidden || undefined} data-loading={loading || undefined}>
        <header className="dash-head">
          <div>
            <p className="dash-kicker">{greeting()}, {name.charAt(0).toUpperCase() + name.slice(1)} 👋</p>
            <h1>Dashboard</h1>
          </div>
          {data && (
            <p className="dash-range">
              {PERIOD_LABELS[filters.period]} ·{' '}
              {new Date(`${data.range.from}T12:00:00`).toLocaleDateString('pt-BR')}
              {data.range.to !== data.range.from && ` a ${new Date(`${data.range.to}T12:00:00`).toLocaleDateString('pt-BR')}`}
            </p>
          )}
        </header>

        {mlReturn?.error && (
          <p className="banner banner-error" role="alert">
            {mlReturn.error}
          </p>
        )}
        <SyncProgress onAdvance={onSyncAdvance} justConnected={Boolean(mlReturn?.connected)} />

        {data?.isDemo && (
          <div className="demo-banner" role="note">
            <img src="/gertrudez.webp" alt="" width="40" height="40" />
            <p>
              <strong>Você está vendo dados de demonstração.</strong> Assim que o Mercado Livre for conectado, este painel mostra
              as suas vendas reais.
            </p>
          </div>
        )}

        <FilterBar
          filters={filters}
          onChange={setFilters}
          accounts={data?.accounts ?? []}
          hidden={hidden}
          onToggleHidden={toggleHidden}
          onRefresh={refresh}
          loading={loading}
          updatedAt={data?.generatedAt}
        />

        {error && (
          <div className="banner banner-error dash-error" role="alert">
            {error} <Button variant="ghost" onClick={refresh}>Tentar de novo</Button>
          </div>
        )}

        {!data && loading ? (
          <div className="kpis" aria-busy="true">
            {[0, 1, 2, 3].map((i) => <div key={i} className="kpi skeleton" />)}
          </div>
        ) : k && p ? (
          <>
            <section className="kpis" aria-label="Indicadores principais">
              <KpiCard
                hero
                label="Faturamento"
                value={k.revenue}
                previous={p.revenue}
                format={money}
                info="Soma do valor de todos os pedidos pagos no período (sem descontar tarifas, frete ou custos)."
              >
                <Sparkline values={data.series.map((s) => s.revenue)} />
              </KpiCard>
              <KpiCard
                label="Líquido do marketplace"
                tone="navy"
                value={k.net}
                previous={p.net}
                format={money}
                info="Faturamento menos tarifas de venda e frete pagos ao marketplace: o que efetivamente cai na sua conta."
              />
              <KpiCard
                label="Lucro bruto"
                tone="amber"
                value={k.grossProfit}
                previous={p.grossProfit}
                format={money}
                info="Líquido do marketplace menos o custo dos produtos e o imposto (Cadastro de SKUs)."
              />
              <KpiCard
                label="Margem"
                tone="teal"
                value={k.margin}
                previous={p.margin}
                format={(n) => pct(n)}
                deltaMode="points"
                info="Lucro bruto dividido pelo faturamento."
              >
                <MarginRing margin={k.margin} />
              </KpiCard>
            </section>

            <section className="minis" aria-label="Outros indicadores">
              <div><span>Pedidos</span><strong>{int(k.orders)}</strong></div>
              <div><span>Unidades vendidas</span><strong>{int(k.units)}</strong></div>
              <div><span>Ticket médio</span><strong className="money">{money(k.avgTicket)}</strong></div>
            </section>

            {data.missingCosts && (
              <p className="costs-note" role="note">
                <strong>Há vendas neste período sem custo de produto cadastrado</strong> — nelas, lucro e margem ainda não
                descontam o custo da mercadoria.{' '}
                <button type="button" className="link" onClick={() => navigate('/skus')}>
                  Cadastrar custos →
                </button>
              </p>
            )}

            <RevenueChart series={data.series} granularity={data.granularity} />
            <div className="dash-duo">
              <TopFive products={data.topProducts} />
              <PausedCarousel paused={data.paused} />
            </div>
          </>
        ) : null}
      </div>
    </AppShell>
  );
}
