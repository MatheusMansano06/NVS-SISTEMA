import { navigate, usePath } from '../../app/router';
import { AppShell } from '../../app/AppShell';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { ReturnsBiView, ReturnsListView, ReturnsScanView, ReturnsSummaryView } from './ReturnsViews';
import '../skus/skus.css';
import '../listings/listings.css';
import '../full/full.css';
import './returns.css';

const TABS = [
  { path: '', label: 'Resumo' },
  { path: '/fila', label: 'Fila da operação' },
  { path: '/bi', label: 'B.I' },
  { path: '/historico', label: 'Histórico' },
  { path: '/bancada', label: 'Bancada (bipe)' },
];

/** Central de Devoluções na Análise: resumo, fila, B.I e histórico (a bancada também abre aqui). */
export function ReturnsPage() {
  const path = usePath();
  const sub = path.replace(/^\/devolucoes/, '');
  const status = new URLSearchParams(window.location.search).get('status') ?? undefined;
  const tour = useGuidedTour('devolucoes', TOURS.devolucoes, true);
  const go = (p: string) => navigate(`/devolucoes${p}`);
  return (
    <AppShell>
      <div className="skus full">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre · pós-venda</p>
            <h1>Central de Devoluções</h1>
          </div>
          <nav className="seg full-tabs" aria-label="Devoluções">
            {TABS.map((t) => (
              <button key={t.path} type="button" role="tab" aria-checked={sub === t.path || (t.path === '' && sub === '/')} onClick={() => go(t.path)}>
                {t.label}
              </button>
            ))}
          </nav>
        </header>
        {sub.startsWith('/fila') ? (
          <ReturnsListView key={status ?? 'fila'} initialStatus={status} />
        ) : sub.startsWith('/bi') ? (
          <ReturnsBiView />
        ) : sub.startsWith('/historico') ? (
          <ReturnsListView history />
        ) : sub.startsWith('/bancada') ? (
          <ReturnsScanView />
        ) : (
          <ReturnsSummaryView onGo={(st) => navigate(`/devolucoes/fila?status=${st}`)} />
        )}
      </div>
      {tour.element}
    </AppShell>
  );
}
