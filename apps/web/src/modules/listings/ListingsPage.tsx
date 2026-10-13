import { useCallback, useEffect, useRef, useState } from 'react';
import type { ListingDto, ListingListDto, ListingTab } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { navigate } from '../../app/router';
import { Modal } from '../../shared/ui/Modal';
import { Pagination } from '../../shared/ui/Pagination';
import { useAuth } from '../auth/AuthContext';
import { ListingCard } from './ListingCard';
import { ListingEditorModal, type EditorTab } from './ListingEditorModal';
import { DuplicateModal } from './DuplicateModal';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { HowTo, ListingsNav } from './ListingsNav';
import { listingsApi } from './listings-api';
import '../skus/skus.css';
import './listings.css';

const TABS: { id: ListingTab; label: string }[] = [
  { id: 'active', label: 'Ativos' },
  { id: 'paused', label: 'Pausados' },
  { id: 'closed', label: 'Finalizados' },
];

const STEPS = [
  { title: 'Encontre o anúncio', text: 'Use as abas (Ativos, Pausados, Finalizados) e a busca por título, SKU ou código MLB.' },
  { title: 'Confira a margem', text: 'O selo MC mostra quanto sobra por venda: verde ≥15%, amarelo 8–15%, vermelho abaixo. Simule outro preço no Precificador.' },
  { title: 'Ajuste na hora', text: 'Estoque no próprio card; preço no “Precificador”; descrição, fotos, ficha, dimensões e atacado nos botões de edição. Tudo vai direto para o Mercado Livre.' },
];

/** Anúncios do Mercado Livre em cartões: lê do banco local (rápido) e só fala com o ML ao alterar. */
export function ListingsPage() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [tab, setTab] = useState<ListingTab>('active');
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(24);
  const [data, setData] = useState<ListingListDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [duplicating, setDuplicating] = useState<ListingDto | null>(null);
  const [editing, setEditing] = useState<{ item: ListingDto; tab: EditorTab } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);

  const load = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError('');
    try {
      setData(await listingsApi.list({ status: tab, q: query || undefined, offset: (page - 1) * pageSize, limit: pageSize }, c.signal));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar os anúncios.');
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [tab, query, page, pageSize]);

  useEffect(() => void load(), [load]);
  useEffect(() => setPage(1), [tab, query, pageSize]);

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), 5000);
  }, []);

  // ajuste local imediato; mudança de status tira o cartão da aba atual
  const patch = useCallback((id: string, change: Partial<ListingDto>) => {
    setData((d) => {
      if (!d) return d;
      if (change.status && change.status !== tab) {
        const from = d.counts[tab];
        const to = d.counts[change.status as ListingTab] ?? 0;
        return {
          ...d,
          items: d.items.filter((i) => i.id !== id),
          total: d.total - 1,
          counts: { ...d.counts, [tab]: from - 1, [change.status]: to + 1 },
        };
      }
      return { ...d, items: d.items.map((i) => (i.id === id ? { ...i, ...change } : i)) };
    });
  }, [tab]);

  const tour = useGuidedTour('anuncios', TOURS['anuncios'], Boolean(data?.items.length));
  // vindo do Radar de Frete (?editar=MLB…&aba=dimensions): abre o editor do anúncio na aba certa
  useEffect(() => {
    const qs = new URLSearchParams(window.location.search);
    const id = qs.get('editar');
    if (!id) return;
    const tab = (qs.get('aba') ?? 'description') as EditorTab;
    window.history.replaceState(null, '', window.location.pathname);
    (async () => {
      for (const status of ['active', 'paused'] as const) {
        const r = await listingsApi.list({ status, q: id, offset: 0, limit: 1 }).catch(() => null);
        const hit = r?.items.find((i) => i.id === id);
        if (hit) return setEditing({ item: hit, tab });
      }
    })();
  }, []);

  const counts = data?.counts;
  return (
    <AppShell>
      <div className="skus listings">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Anúncios</h1>
          </div>
        </header>
        <ListingsNav />
        <HowTo steps={STEPS} storageKey="nvs:howto:anuncios" onTour={tour.start} />

        {data && !data.connected && (
          <p className="banner banner-error">
            Nenhuma conta do Mercado Livre conectada. <button type="button" className="link" onClick={() => navigate('/')}>Conectar no painel</button>
          </p>
        )}
        {msg && <p className={`banner banner-${msg.kind}`} role="status">{msg.text}</p>}

        <div className="skus-toolbar">
          <label className="search">
            <span className="sr-only">Buscar</span>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
            <input placeholder="Buscar por título, SKU ou MLB" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="seg" role="radiogroup" aria-label="Situação do anúncio">
            {TABS.map((t) => (
              <button key={t.id} type="button" role="radio" aria-checked={tab === t.id} onClick={() => setTab(t.id)}>
                {t.label}
                {counts && <span>{counts[t.id]}</span>}
              </button>
            ))}
          </div>
        </div>

        {error && (
          <p className="banner banner-error" role="alert">
            {error} <button type="button" className="link" onClick={() => void load()}>Tentar de novo</button>
          </p>
        )}

        {!loading && data && data.items.length === 0 ? (
          <div className="skus-empty">
            <strong>Nenhum anúncio encontrado</strong>
            <p>{query ? 'Tente outra busca.' : 'Sincronize o Mercado Livre para trazer seus anúncios.'}</p>
          </div>
        ) : (
          <div className="lgrid" aria-busy={loading}>
            {(data?.items ?? []).map((item) => (
              <ListingCard
                key={item.id}
                item={item}
                canManage={canManage}
                onChanged={(change) => patch(item.id, change)}
                onPricing={() => navigate(`/precificador?anuncio=${encodeURIComponent(item.id)}`)}
                onSales={() => navigate(`/vendas?anuncio=${encodeURIComponent(item.id)}`)}
                onEdit={(tab) => setEditing({ item, tab })}
                onDuplicate={() => setDuplicating(item)}
                onMsg={notify}
              />
            ))}
            {loading && !data && Array.from({ length: 6 }, (_, i) => <div key={i} className="lcard lcard-skeleton" aria-hidden="true" />)}
          </div>
        )}

        {data && data.total > 0 && (
          <Pagination
            page={page}
            pageSize={pageSize}
            total={data.total}
            sizes={[12, 24, 48]}
            onPage={(p) => {
              setPage(p);
              window.scrollTo({ top: 0, behavior: 'smooth' });
            }}
            onPageSize={setPageSize}
            label="anúncios"
          />
        )}
      </div>

      <Modal open={editing !== null} onClose={() => setEditing(null)} label="Editar anúncio" wide>
        {editing && (
          <ListingEditorModal
            key={`${editing.item.id}:${editing.tab}`}
            item={editing.item}
            initialTab={editing.tab}
            canManage={canManage}
            onSaved={(text) => {
              notify('ok', text);
              void load();
            }}
          />
        )}
      </Modal>
      <Modal open={duplicating !== null} onClose={() => setDuplicating(null)} label="Duplicar anúncio" wide>
        {duplicating && (
          <DuplicateModal
            item={duplicating}
            onDone={(text) => {
              setDuplicating(null);
              notify('ok', text);
              void load();
            }}
          />
        )}
      </Modal>
      {tour.element}
    </AppShell>
  );
}
