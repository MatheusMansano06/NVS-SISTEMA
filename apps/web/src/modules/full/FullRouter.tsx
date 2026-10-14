import { useState } from 'react';
import type { WmsMarketplace } from '@nvs/shared';
import { navigate, usePath } from '../../app/router';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { BatchDetail, BatchesView } from './BatchesView';
import { FullOverview } from './FullOverview';
import { OperatorHome } from './OperatorHome';
import { PickingScreen } from './PickingScreen';
import { ProcessingView } from './ProcessingView';
import { ProductsView } from './ProductsView';
import { ShortageReport } from './ShortageReport';
import { getFullMarketplace, setFullMarketplace } from './full-api';
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
  const base = mode === 'analise' ? '/full' : '/op/full';
  const path = usePath();
  const [mp, setMp] = useState<WmsMarketplace>(getFullMarketplace());
  const tour = useGuidedTour(mode === 'analise' ? 'full' : 'full-operacao', mode === 'analise' ? TOURS.full : TOURS['full-operacao'], true);
  const sub = path.startsWith(base) ? path.slice(base.length) || '/' : '/';
  const qs = new URLSearchParams(window.location.search);
  const go = (p: string) => navigate(`${base}${p}`);
  const openList = (id: string, sku?: string) => navigate(`${base}/lista/${id}${sku ? `?sku=${encodeURIComponent(sku)}` : ''}`);

  const tabs: Tab[] =
    mode === 'analise'
      ? [
          { path: '/', label: 'Visão Geral' },
          { path: '/listas', label: 'Listas e Lotes' },
          { path: '/faltas', label: 'Faltas' },
          { path: '/processamento', label: 'Processamento' },
          { path: '/produtos', label: 'Produtos (Master Data)' },
        ]
      : [
          { path: '/', label: 'Separar' },
          { path: '/visao', label: 'Visão Geral' },
          { path: '/listas', label: 'Listas e Lotes' },
          { path: '/faltas', label: 'Faltas' },
          { path: '/produtos', label: 'Produtos' },
        ];
  const overviewPath = mode === 'analise' ? '/' : '/visao';
  const active = tabs.find((t) => t.path !== '/' && sub.startsWith(t.path))?.path ?? (sub.startsWith('/lote') ? '/listas' : sub === '/' ? '/' : '');

  let body;
  const m = (re: RegExp) => re.exec(sub)?.[1];
  if (m(/^\/lista\/([0-9a-f-]{36})/)) {
    body = <PickingScreen key={sub + qs.get('sku')} listId={m(/^\/lista\/([0-9a-f-]{36})/)!} focus={qs.get('sku') ?? undefined} onBack={() => window.history.back()} onOpen={openList} />;
  } else if (m(/^\/lote\/([0-9a-f-]{36})/)) {
    body = <BatchDetail id={m(/^\/lote\/([0-9a-f-]{36})/)!} onBack={() => go('/listas')} onOpenList={openList} />;
  } else if (sub.startsWith('/listas')) {
    body = <BatchesView onOpenBatch={(id) => go(`/lote/${id}`)} onOpenList={openList} />;
  } else if (sub.startsWith('/faltas')) {
    body = <ShortageReport onOpenList={openList} />;
  } else if (sub.startsWith('/produtos')) {
    body = <ProductsView />;
  } else if (sub.startsWith('/processamento') && mode === 'analise') {
    body = <ProcessingView onDone={(id, m) => { setFullMarketplace(m); setMp(m); go(`/lote/${id}`); }} />;
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
            <p className="dash-kicker">{mp === 'ml' ? 'Mercado Livre' : 'Shopee'} · Full</p>
            <h1>Supervisão Full</h1>
          </div>
          <div className="seg full-mp" role="tablist" aria-label="Marketplace">
            {(['ml', 'shopee'] as const).map((m) => (
              <button
                key={m}
                type="button"
                role="tab"
                aria-checked={mp === m}
                data-mp={m}
                onClick={() => {
                  setFullMarketplace(m);
                  setMp(m);
                  if (sub.startsWith('/lote') || sub.startsWith('/lista')) go(mode === 'analise' ? '/listas' : '/');
                }}
              >
                {m === 'ml' ? 'Mercado Livre' : 'Shopee'}
              </button>
            ))}
          </div>
          <nav className="seg full-tabs" aria-label="Supervisão Full">
            {tabs.map((t) => (
              <button key={t.path} type="button" role="tab" aria-checked={active === t.path} onClick={() => go(t.path)}>
                {t.label}
              </button>
            ))}
          </nav>
          <button type="button" className="link full-tour" onClick={tour.start}>Rever com a Gertrudez</button>
        </header>
      )}
      <div key={mp} className="full-body">{body}</div>
      {tour.element}
    </div>
  );
}
