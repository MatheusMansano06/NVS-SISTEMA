import { useCallback, useEffect, useRef, useState } from 'react';
import type { Marketplace, SkuFilter, SkuListDto, SkuRowDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { pct } from '../../shared/format';
import { Button } from '../../shared/ui/Button';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { useFeature } from '../../shared/features';
import { EanTab } from './EanTab';
import { LinkSkuModal } from './LinkSkuModal';
import { PLATFORM_LABELS } from './platforms';
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
/** Plataformas que a empresa pode ter além do Mercado Livre (cada uma é um recurso liberado). */
const PLATFORMS: Marketplace[] = ['mercado_livre', 'tiktok_shop', 'shopee'];

/** Cadastro de SKUs: custo unitário e imposto que alimentam lucro, margem e a análise financeira. */
export function SkuPage() {
  const [view, setView] = useState<'costs' | 'ean'>(() => (new URLSearchParams(window.location.search).get('aba') === 'ean' ? 'ean' : 'costs'));
  const [filter, setFilter] = useState<SkuFilter>('missing');
  // mais de um marketplace: SKUs separados por plataforma e vínculo entre eles
  const hasTiktok = useFeature('tiktok_shop');
  const hasShopee = useFeature('shopee');
  const multi = hasTiktok || hasShopee;
  const [platform, setPlatform] = useState<Marketplace | ''>('');
  const [linking, setLinking] = useState<SkuRowDto | null>(null);
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
    async (fresh = false) => {
      const offset = (page - 1) * pageSize;
      ctrl.current?.abort();
      const c = new AbortController();
      ctrl.current = c;
      setLoading(true);
      setError('');
      try {
        const r = await skusApi.list({ q: query || undefined, filter, platform: platform || undefined, fresh, offset, limit: pageSize }, c.signal);
        setItems(r.items);
        setMeta({ total: r.total, counts: r.counts });
      } catch (err) {
        if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar os SKUs.');
      } finally {
        if (ctrl.current === c) setLoading(false);
      }
    },
    [filter, platform, query, page, pageSize],
  );

  useEffect(() => {
    void load();
  }, [load]);

  // mudou busca/filtro → volta para a página 1
  useEffect(() => setPage(1), [filter, platform, query, pageSize]);

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
          <button type="button" className="icon-btn" onClick={() => void load(true)} aria-label="Atualizar lista" title="Reler anúncios e vendas agora" data-spinning={loading || undefined}>
            <Icon name="refresh" />
          </button>
          {multi && (
            <div className="seg" role="radiogroup" aria-label="Plataforma">
              <button type="button" role="radio" aria-checked={platform === ''} onClick={() => setPlatform('')}>Todas</button>
              {PLATFORMS.filter((p) => p === 'mercado_livre' || (p === 'tiktok_shop' ? hasTiktok : hasShopee)).map((p) => (
                <button key={p} type="button" role="radio" aria-checked={platform === p} onClick={() => setPlatform(p)}>{PLATFORM_LABELS[p]}</button>
              ))}
            </div>
          )}
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
              <SkuRow key={r.sku} row={r} onSaved={onSaved} platforms={multi} onLink={setLinking} onChanged={() => void load()} />
            ))}
          </ul>
        )}

        {meta && meta.total > 0 && (
          <Pagination page={page} pageSize={pageSize} total={meta.total} onPage={goTo} onPageSize={setPageSize} label="SKUs" />
        )}
        </>}
      </div>

      <Modal open={linking !== null} onClose={() => setLinking(null)} label="Vincular a outro SKU" wide>
        {linking && (
          <LinkSkuModal
            row={linking}
            onDone={() => {
              setLinking(null);
              void load();
            }}
          />
        )}
      </Modal>
      <Modal open={importing} onClose={() => setImporting(false)} label="Importar planilha">
        <ImportModal onDone={() => void load()} />
      </Modal>
      {tour.element}
    </AppShell>
  );
}
