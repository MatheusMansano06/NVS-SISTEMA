import { useCallback, useEffect, useRef, useState } from 'react';
import type { SkuFilter, SkuListDto, SkuRowDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { pct } from '../../shared/format';
import { Button } from '../../shared/ui/Button';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { EanTab } from './EanTab';
import { ImportModal } from './ImportModal';
import { TaxRateCard } from './TaxRateCard';
import { Pagination } from '../../shared/ui/Pagination';
import { SkuRow } from './SkuRow';
import { skusApi } from './skus-api';
import './skus.css';

const FILTERS: { id: SkuFilter; label: string }[] = [
  { id: 'missing', label: 'Sem custo' },
  { id: 'done', label: 'Com custo' },
  { id: 'all', label: 'Todos' },
];

/** Cadastro de SKUs: custo unitário e imposto que alimentam lucro, margem e a análise financeira. */
export function SkuPage() {
  const [view, setView] = useState<'costs' | 'ean'>(() => (new URLSearchParams(window.location.search).get('aba') === 'ean' ? 'ean' : 'costs'));
  const [filter, setFilter] = useState<SkuFilter>('missing');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [items, setItems] = useState<SkuRowDto[]>([]);
  const [meta, setMeta] = useState<Pick<SkuListDto, 'total' | 'counts'> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [importing, setImporting] = useState(false);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  const ctrl = useRef<AbortController | null>(null);

  // busca com atraso curto enquanto digita
  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(
    async () => {
      const offset = (page - 1) * pageSize;
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      try {
        const r = await skusApi.list({ q: query || undefined, filter, offset, limit: pageSize }, c.signal);
        setItems(r.items);
        setMeta({ total: r.total, counts: r.counts });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar os SKUs.');
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    },
    [filter, query, page, pageSize],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // mudou busca/filtro → volta para a página 1
  useEffect(() => setPage(1), [filter, query, pageSize]);

  const goTo = (p: number) => {
    setPage(p);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const onSaved = useCallback((sku: string, custo: number) => {
    setItems((prev) => prev.map((r) => (r.sku === sku ? { ...r, custoUnit: custo } : r)));
    setMeta((m) => {
      if (!m) return m;
      const was = items.find((r) => r.sku === sku)?.custoUnit ?? null;
      if (was !== null) return m;
      return { ...m, counts: { ...m.counts, done: m.counts.done + 1, missing: m.counts.missing - 1 } };
    });
  }, [items]);

  const counts = meta?.counts;
  const filled = counts && counts.all ? counts.done / counts.all : 0;

  const tour = useGuidedTour('skus', TOURS.skus, !loading && items.length > 0);
  return (
    <AppShell>
      <div className="skus">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Custos e impostos</p>
            <h1>Cadastro de SKUs</h1>
          </div>
          <div className="seg" role="tablist" aria-label="Cadastro de SKUs">
            <button type="button" role="tab" aria-checked={view === 'costs'} onClick={() => setView('costs')}>Custos</button>
            <button type="button" role="tab" aria-checked={view === 'ean'} onClick={() => setView('ean')}>Códigos EAN</button>
          </div>
          {view === 'costs' && <div className="skus-actions">
            <a className="btn btn-ghost btn-sm" href={skusApi.exportUrl} download>
              <Icon name="logout" size={16} /> Exportar planilha
            </a>
            <Button variant="ghost" className="btn-sm" onClick={() => setImporting(true)}>
              Importar planilha
            </Button>
          </div>}
        </header>

        {view === 'ean' ? <EanTab /> : <>

        {/* quanto do sistema já está "preenchido" com custos */}
        <section className="fill" aria-label="Preenchimento dos custos">
          <img src="/gertrudez.webp" alt="" />
          <div className="fill-body">
            <div className="fill-head">
              <strong>
                {counts ? `${counts.done} de ${counts.all} SKUs com custo` : 'Carregando…'}
              </strong>
              <span className="fill-pct">{pct(filled, 0)}</span>
            </div>
            <div className="fill-bar" role="progressbar" aria-valuenow={Math.round(filled * 100)} aria-valuemin={0} aria-valuemax={100}>
              <span style={{ width: `${filled * 100}%` }} />
            </div>
            <p>
              Comece pelos <b>mais vendidos</b>: eles pesam mais no seu lucro. O primeiro custo de um SKU vale para todo o
              histórico; alterações depois valem a partir do dia em que forem feitas.
            </p>
          </div>
        </section>

        <TaxRateCard />

        <div className="skus-toolbar">
          <label className="search">
            <span className="sr-only">Buscar</span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input placeholder="Buscar por SKU ou título" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Filtro">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="radio" aria-checked={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label}
                {counts && <span>{f.id === 'all' ? counts.all : f.id === 'done' ? counts.done : counts.missing}</span>}
              </button>
            ))}
          </div>
        </div>

        {error && <p className="banner banner-error" role="alert">{error}</p>}

        {!loading && items.length === 0 ? (
          <div className="skus-empty">
            {filter === 'missing' && counts?.all ? (
              <>
                <strong>Tudo preenchido! 🎉</strong>
                <p>Todos os SKUs têm custo. Lucro e margem do dashboard já estão completos.</p>
              </>
            ) : (
              <>
                <strong>Nenhum SKU encontrado</strong>
                <p>{query ? 'Tente outra busca.' : 'Conecte o Mercado Livre e sincronize para trazer seus anúncios.'}</p>
              </>
            )}
          </div>
        ) : (
          <ul className="sku-list" aria-busy={loading}>
            {items.map((r) => (
              <SkuRow key={r.sku} row={r} onSaved={onSaved} />
            ))}
          </ul>
        )}

        {meta && meta.total > 0 && (
          <Pagination page={page} pageSize={pageSize} total={meta.total} onPage={goTo} onPageSize={setPageSize} label="SKUs" />
        )}
        </>}
      </div>

      <Modal open={importing} onClose={() => setImporting(false)} label="Importar planilha">
        <ImportModal onDone={() => void load()} />
      </Modal>
      {tour.element}
    </AppShell>
  );
}
