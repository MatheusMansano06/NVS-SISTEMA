import { useCallback, useEffect, useRef, useState } from 'react';
import {
  LOGISTIC_LABELS,
  PAYMENT_LABEL,
  SALES_PERIODS,
  UF_NAME,
  marginTone,
  type ListingDto,
  type LogisticBucketId,
  type SalesOverviewDto,
  type SalesPeriod,
} from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { int, money, pct } from '../../shared/format';
import { useAuth } from '../auth/AuthContext';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { HowTo } from '../listings/ListingsNav';
import { listingsApi } from '../listings/listings-api';
import { DifalCard } from './DifalCard';
import { OrdersList } from './OrdersList';
import { Ring } from './Ring';
import { salesApi } from './sales-api';
import '../skus/skus.css';
import '../listings/listings.css';
import './sales.css';

const PERIOD_LABEL: Record<SalesPeriod, string> = {
  '7d': '7 dias',
  '30d': '30 dias',
  '90d': '90 dias',
  this_month: 'Este mês',
  last_month: 'Mês passado',
};

const STEPS = [
  { title: 'Escolha o período', text: 'Tudo na tela respeita o período: indicadores, gráficos, DIFAL e a lista de vendas.' },
  { title: 'Geral ou por anúncio', text: 'Sem filtro você vê a loja inteira. Busque um anúncio (ou clique na lupa do card em Anúncios) para ver só ele.' },
  { title: 'Confira o DIFAL', text: 'Estimativa do imposto das vendas para outros estados. Ajuste a origem e as alíquotas em “Configurar”.' },
];

const PAY_SHORT: Record<string, string> = { pix: 'Pix', credit: 'Crédito', debit: 'Débito', balance: 'Saldo MP', other: 'Outros' };

const readParam = () => new URLSearchParams(window.location.search).get('anuncio') ?? undefined;
const monthLabel = (m: string) => {
  const s = new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'short', year: '2-digit' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Aba Vendas: visão geral da loja (ou de um anúncio) com pagamento, envio, estados, DIFAL e cada venda. */
export function SalesPage() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [period, setPeriod] = useState<SalesPeriod>('30d');
  const [listingId, setListingId] = useState<string | undefined>(readParam);
  const [data, setData] = useState<SalesOverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  // o anúncio escolhido fica na URL (dá para compartilhar/voltar)
  useEffect(() => {
    const url = new URL(window.location.href);
    if (listingId) url.searchParams.set('anuncio', listingId);
    else url.searchParams.delete('anuncio');
    window.history.replaceState(null, '', url);
  }, [listingId]);

  const load = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError('');
    try {
      setData(await salesApi.overview({ period, listingId }, c.signal));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar as vendas.');
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [period, listingId]);
  useEffect(() => void load(), [load]);

  const tour = useGuidedTour('vendas', TOURS['vendas'], Boolean(data));
  const k = data?.kpis;
  const topStates = data ? data.states.slice(0, 8) : [];
  const otherStates = data ? data.states.slice(8).reduce((s, x) => s + x.orders, 0) : 0;
  const maxMonth = Math.max(1, ...(data?.months.map((m) => m.revenue) ?? [1]));

  return (
    <AppShell>
      <div className="skus sales" aria-busy={loading}>
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Vendas</h1>
          </div>
          <div className="seg" role="radiogroup" aria-label="Período">
            {SALES_PERIODS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>{PERIOD_LABEL[p]}</button>
            ))}
          </div>
        </header>
        <HowTo steps={STEPS} storageKey="nvs:howto:vendas" onTour={tour.start} />

        <ListingFilter value={listingId} listing={data?.listing ?? null} onChange={setListingId} />
        {error && <p className="banner banner-error" role="alert">{error}</p>}

        {k && (
          <section className="skpis" aria-label="Indicadores">
            <div><small>Vendas</small><b>{int(k.orders)}</b>{k.cancelled > 0 && <span>{k.cancelled} canceladas/devolvidas</span>}</div>
            <div><small>Unidades</small><b>{int(k.units)}</b></div>
            <div><small>Receita</small><b>{money(k.revenue)}</b></div>
            <div data-tone={marginTone(k.profitPct)}>
              <small>Lucro</small>
              <b>{k.profit === null ? '—' : money(k.profit)}</b>
              <span>{k.profit === null ? 'há vendas sem custo cadastrado' : `${pct(k.profitPct ?? 0, 1)} da receita`}</span>
            </div>
            {data?.listing && (
              <>
                <div><small>Disponível hoje</small><b>{data.listing.stock === null ? '—' : int(data.listing.stock)}</b></div>
                <div><small>Vendidos (ML, total)</small><b>{data.listing.sold === null ? '—' : int(data.listing.sold)}</b></div>
              </>
            )}
          </section>
        )}

        {data && (
          <div className="scharts">
            <section className="scard">
              <h2>Formas de pagamento</h2>
              <Ring
                title="Formas de pagamento"
                parts={data.payments.map((p) => ({ key: p.group, label: PAY_SHORT[p.group] ?? PAYMENT_LABEL[p.group], value: p.orders, extra: String(p.orders) }))}
              />
            </section>
            <section className="scard">
              <h2>Modalidade de envio</h2>
              <Ring
                title="Modalidade de envio"
                parts={data.shipping.map((s) => ({ key: s.bucket, label: LOGISTIC_LABELS[s.bucket as LogisticBucketId] ?? s.bucket, value: s.orders, extra: String(s.orders) }))}
              />
            </section>
            <section className="scard">
              <h2>Estados (para onde vendeu)</h2>
              <Ring
                title="Estados"
                parts={[
                  ...topStates.map((s) => ({ key: s.uf, label: s.uf, title: UF_NAME[s.uf], value: s.orders, extra: String(s.orders) })),
                  ...(otherStates ? [{ key: 'outros', label: 'Outros', value: otherStates, extra: String(otherStates) }] : []),
                ]}
              />
              {data.located.orders < data.located.total && (
                <p className="scard-note">{data.located.orders} de {data.located.total} vendas com destino conhecido · completando o resto em segundo plano</p>
              )}
            </section>
          </div>
        )}

        {data && <DifalCard data={data} canManage={canManage} onSaved={() => void load()} />}

        {data && data.months.length > 0 && (
          <section className="scard" aria-label="Mês a mês">
            <header className="scard-head"><div><h2>Mês a mês</h2><p>Receita, lucro e DIFAL de cada mês (da fatura do ML quando disponível)</p></div></header>
            <ul className="smonths">
              {data.months.map((m) => (
                <li key={m.month}>
                  <span className="smonths-label">{monthLabel(m.month)}</span>
                  <div className="smonths-bar" aria-hidden="true"><span style={{ width: `${(m.revenue / maxMonth) * 100}%` }} /></div>
                  <span><small>Receita</small><b>{money(m.revenue)}</b></span>
                  <span data-tone={marginTone(m.profit !== null && m.revenue ? m.profit / m.revenue : null)}><small>Lucro</small><b>{m.profit === null ? '—' : money(m.profit)}</b></span>
                  <span title={m.difalBilled === null ? 'Estimativa pelas vendas (fatura ainda não sincronizada)' : 'Cobrado na fatura do ML'}>
                    <small>{m.difalBilled === null ? 'DIFAL ≈' : 'DIFAL fatura'}</small>
                    <b>{money(m.difal)}</b>
                  </span>
                  <span><small>Vendas</small><b>{int(m.orders)}</b></span>
                </li>
              ))}
            </ul>
          </section>
        )}

        <OrdersList period={period} listingId={listingId} />
      </div>
      {tour.element}
    </AppShell>
  );
}

/** Busca um anúncio para filtrar a página; mostra o escolhido com foto. */
function ListingFilter({ value, listing, onChange }: { value?: string; listing: SalesOverviewDto['listing']; onChange: (id?: string) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ListingDto[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setResults([]);
      return;
    }
    const t = window.setTimeout(async () => {
      const [a, p] = await Promise.all([
        listingsApi.list({ status: 'active', q: term, offset: 0, limit: 6 }).catch(() => null),
        listingsApi.list({ status: 'paused', q: term, offset: 0, limit: 4 }).catch(() => null),
      ]);
      setResults([...(a?.items ?? []), ...(p?.items ?? [])]);
      setOpen(true);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);

  if (value) {
    return (
      <div className="sfilter-chosen">
        <ProductThumb src={listing?.pictureUrl ?? null} alt={listing?.title ?? value} />
        <div>
          <small>Mostrando só este anúncio</small>
          <strong>{listing?.title ?? value}</strong>
          <span>{listing?.sku ? `${listing.sku} · ` : ''}{value}</span>
        </div>
        <button type="button" className="act" onClick={() => onChange(undefined)}>Ver todos os anúncios</button>
      </div>
    );
  }
  return (
    <div className="sfilter">
      <label className="search">
        <span className="sr-only">Filtrar por anúncio</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input
          placeholder="Ver um anúncio específico: título, SKU ou MLB"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => results.length && setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
        />
      </label>
      {open && results.length > 0 && (
        <ul className="sfilter-results" role="listbox">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => { onChange(r.id); setQ(''); setOpen(false); }}>
                <ProductThumb src={r.pictureUrl} alt={r.title} />
                <span><strong>{r.sku ?? r.id}</strong><small>{r.title}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
