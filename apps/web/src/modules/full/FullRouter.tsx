import { navigate, usePath } from '../../app/router';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { BatchDetail, BatchesView, ShortagesView } from './BatchesView';
import { FullOverview } from './FullOverview';
import { OperatorHome } from './OperatorHome';
import { PickingScreen } from './PickingScreen';
import { ProcessingView } from './ProcessingView';
import { ProductsView } from './ProductsView';
import '../skus/skus.css';
import '../listings/listings.css';
import './full.css';

type Tab = { path: string; label: string };

/**
 * Supervisão Full nas duas pontas, com as mesmas telas:
 * Análise (/full): Visão Geral, Listas e Lotes, Processamento e Produtos.
 * Operação (/op): Painel de operação (separar), Visão Geral, Listas e Lotes e Produtos.
 */
export function FullRouter({ mode }: { mode: 'analise' | 'operacao' }) {
  const base = mode === 'analise' ? '/full' : '/op';
  const path = usePath();
  const tour = useGuidedTour('full', TOURS.full, mode === 'analise');
  const sub = path.startsWith(base) ? path.slice(base.length) || '/' : '/';
  const qs = new URLSearchParams(window.location.search);
  const go = (p: string) => navigate(`${base}${p}`);
  const openList = (id: string, sku?: string) => navigate(`${base}/lista/${id}${sku ? `?sku=${encodeURIComponent(sku)}` : ''}`);

  const tabs: Tab[] =
    mode === 'analise'
      ? [
          { path: '/', label: 'Visão Geral' },
          { path: '/listas', label: 'Listas e Lotes' },
          { path: '/processamento', label: 'Processamento' },
          { path: '/produtos', label: 'Produtos (Master Data)' },
        ]
      : [
          { path: '/', label: 'Separar' },
          { path: '/visao', label: 'Visão Geral' },
          { path: '/listas', label: 'Listas e Lotes' },
          { path: '/produtos', label: 'Produtos' },
        ];
  const overviewPath = mode === 'analise' ? '/' : '/visao';
  const active = tabs.find((t) => t.path !== '/' && sub.startsWith(t.path))?.path ?? (sub.startsWith('/lote') ? '/listas' : sub === '/' ? '/' : sub.startsWith('/faltas') ? overviewPath : '');

  let body;
  const m = (re: RegExp) => re.exec(sub)?.[1];
  if (m(/^\/lista\/([0-9a-f-]{36})/)) {
    body = <PickingScreen key={sub + qs.get('sku')} listId={m(/^\/lista\/([0-9a-f-]{36})/)!} focus={qs.get('sku') ?? undefined} onBack={() => window.history.back()} onOpen={openList} />;
  } else if (m(/^\/lote\/([0-9a-f-]{36})/)) {
    body = <BatchDetail id={m(/^\/lote\/([0-9a-f-]{36})/)!} onBack={() => go('/listas')} onOpenList={openList} />;
  } else if (sub.startsWith('/listas')) {
    body = <BatchesView onOpenBatch={(id) => go(`/lote/${id}`)} onOpenList={openList} />;
  } else if (sub.startsWith('/faltas')) {
    body = <ShortagesView onBack={() => go(overviewPath)} />;
  } else if (sub.startsWith('/produtos')) {
    body = <ProductsView />;
  } else if (sub.startsWith('/processamento') && mode === 'analise') {
    body = <ProcessingView onDone={(id) => go(`/lote/${id}`)} />;
  } else if (sub === overviewPath || (mode === 'analise' && sub === '/')) {
    body = <FullOverview onShortages={() => go('/faltas')} onLists={() => go('/listas')} />;
  } else {
    body = <OperatorHome onOpen={openList} />;
  }

  const picking = sub.startsWith('/lista/');
  return (
    <div className="skus full">
      {!picking && (
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre · Full</p>
            <h1>Supervisão Full</h1>
          </div>
          <nav className="seg full-tabs" aria-label="Supervisão Full">
            {tabs.map((t) => (
              <button key={t.path} type="button" role="tab" aria-checked={active === t.path} onClick={() => go(t.path)}>
                {t.label}
              </button>
            ))}
          </nav>
        </header>
      )}
      {body}
      {mode === 'analise' && tour.element}
    </div>
  );
}
