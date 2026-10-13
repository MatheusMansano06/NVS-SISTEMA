import { useCallback, useEffect, useRef, useState } from 'react';
import { LOGISTIC_LABELS, PAYMENT_GROUPS, PAYMENT_LABEL, marginTone, type LogisticBucketId, type PaymentGroup, type SaleOrdersDto, type SalesPeriod } from '@nvs/shared';
import { money, pct } from '../../shared/format';
import { salesApi } from './sales-api';

const STATUS = { paid: 'Paga', cancelled: 'Cancelada', returned: 'Devolvida' } as const;
const PAGE = 15;

/** Pedidos do período (ou do anúncio) com a conta de cada venda. */
export function OrdersList({ period, listingId }: { period: SalesPeriod; listingId?: string }) {
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [payment, setPayment] = useState<PaymentGroup | undefined>();
  const [page, setPage] = useState(0);
  const [data, setData] = useState<SaleOrdersDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(0), [query, payment, period, listingId]);

  const load = useCallback(async () => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError('');
    try {
      setData(await salesApi.orders({ period, listingId, q: query || undefined, payment, offset: page * PAGE, limit: PAGE }, c.signal));
    } catch (err) {
      if ((err as Error).name !== 'AbortError') setError('Não foi possível carregar as vendas.');
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [period, listingId, query, payment, page]);
  useEffect(() => void load(), [load]);

  const last = data ? Math.max(0, Math.ceil(data.total / PAGE) - 1) : 0;
  return (
    <section className="scard" aria-label="Vendas">
      <header className="scard-head">
        <div>
          <h2>Vendas</h2>
          <p>{data ? `${data.total.toLocaleString('pt-BR')} pedidos no período` : 'Carregando…'}</p>
        </div>
      </header>
      <div className="skus-toolbar">
        <label className="search">
          <span className="sr-only">Buscar</span>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
          <input placeholder="Comprador, pedido, carrinho, CEP, cidade, SKU…" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        <div className="seg" role="radiogroup" aria-label="Forma de pagamento">
          <button type="button" role="radio" aria-checked={!payment} onClick={() => setPayment(undefined)}>Todos</button>
          {PAYMENT_GROUPS.map((g) => (
            <button key={g} type="button" role="radio" aria-checked={payment === g} onClick={() => setPayment(g)}>{PAYMENT_LABEL[g]}</button>
          ))}
        </div>
      </div>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <ul className="sorders" aria-busy={loading}>
        {data?.items.map((o) => {
          const tone = o.status === 'paid' && o.profit !== null && o.revenue ? marginTone(o.profit / o.revenue) : 'none';
          return (
            <li key={o.id} className="sorder" data-status={o.status}>
              <div className="sorder-who">
                <strong>{o.buyer ?? 'Comprador'}</strong>
                <small>Pedido <code>{o.id}</code>{o.packId ? <> · carrinho <code>{o.packId}</code></> : null}</small>
                <small>
                  {o.city || o.uf ? `${o.city ?? ''}${o.uf ? `/${o.uf}` : ''}` : 'destino ainda não carregado'}
                  {o.zip ? ` · CEP ${o.zip.replace(/^(\d{5})(\d{3})$/, '$1-$2')}` : ''}
                </small>
                <small>{new Date(o.orderedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>
              </div>
              <div className="sorder-items">
                {o.items.map((i, k) => (
                  <p key={k}>
                    <span className="tag tag-type">{i.quantity}x</span> <b>{money(i.unitPrice)}</b> <code>{i.sku}</code>
                    <span className="sorder-title">{i.title}</span>
                  </p>
                ))}
                <p className="sorder-tags">
                  <span className="tag tag-pay">{PAYMENT_LABEL[o.payment]}{o.installments && o.installments > 1 ? ` ${o.installments}x` : ''}</span>
                  {o.logistic && <span className="tag tag-paused">{LOGISTIC_LABELS[o.logistic as LogisticBucketId] ?? o.logistic}</span>}
                  {o.status !== 'paid' && <span className="tag tag-missing">{STATUS[o.status]}</span>}
                </p>
              </div>
              <dl className="sorder-money">
                <div><dt>Receita</dt><dd>{money(o.revenue)}</dd></div>
                <div><dt>Tarifa ML</dt><dd>− {money(o.fee)}</dd></div>
                <div><dt>Frete</dt><dd>− {money(o.freight)}</dd></div>
                <div><dt>Imposto</dt><dd>− {money(o.tax)}</dd></div>
                <div><dt>Custo produto</dt><dd>{o.cost === null ? 'sem custo' : `− ${money(o.cost)}`}</dd></div>
                <div className="sorder-profit" data-tone={tone}>
                  <dt>Lucro</dt>
                  <dd>{o.status !== 'paid' ? '—' : o.profit === null ? '—' : `${money(o.profit)} (${pct(o.profit / (o.revenue || 1), 1)})`}</dd>
                </div>
              </dl>
            </li>
          );
        })}
        {data && !data.items.length && <li className="lsales-empty">Nenhuma venda encontrada.</li>}
      </ul>
      {data && last > 0 && (
        <div className="lsales-pager">
          <button type="button" className="act" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Anterior</button>
          <span>Página {page + 1} de {last + 1}</span>
          <button type="button" className="act" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima ›</button>
        </div>
      )}
    </section>
  );
}
