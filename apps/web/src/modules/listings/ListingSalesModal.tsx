import { useEffect, useState } from 'react';
import { marginTone, type ListingDto, type ListingMonthDto, type ListingSalesDto } from '@nvs/shared';
import { int, money, pct } from '../../shared/format';
import { listingsApi } from './listings-api';

const STATUS = { paid: 'Paga', cancelled: 'Cancelada', returned: 'Devolvida' } as const;
const PAGE = 15;

const monthLabel = (m: string) => {
  const s = new Date(`${m}-15T12:00:00`).toLocaleDateString('pt-BR', { month: 'long', year: 'numeric' });
  return s.charAt(0).toUpperCase() + s.slice(1);
};

/** Vendas do anúncio (pedidos já sincronizados — nada é buscado no marketplace). */
export function ListingSalesModal({ item }: { item: ListingDto }) {
  const [tab, setTab] = useState<'sales' | 'months'>('sales');
  return (
    <div className="lsales">
      <h2>Vendas do anúncio</h2>
      <p className="lprice-sub">{item.title}</p>
      <div className="ledit-tabs" role="tablist" aria-label="Visão">
        <button type="button" role="tab" aria-selected={tab === 'sales'} onClick={() => setTab('sales')}>Venda a venda</button>
        <button type="button" role="tab" aria-selected={tab === 'months'} onClick={() => setTab('months')}>Por mês</button>
      </div>
      {tab === 'sales' ? <SalesList item={item} /> : <Months item={item} />}
    </div>
  );
}

function SalesList({ item }: { item: ListingDto }) {
  const [page, setPage] = useState(0);
  const [data, setData] = useState<ListingSalesDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    let alive = true;
    setError('');
    listingsApi
      .sales(item.id, page * PAGE, PAGE)
      .then((d) => alive && setData(d))
      .catch(() => alive && setError('Não foi possível carregar as vendas.'));
    return () => {
      alive = false;
    };
  }, [item.id, page]);

  const last = data ? Math.max(0, Math.ceil(data.total / PAGE) - 1) : 0;
  return (
    <>
      {data && (
        <div className="lsales-totals">
          <span><small>Pedidos pagos</small><b>{int(data.totals.orders)}</b></span>
          <span><small>Unidades</small><b>{int(data.totals.units)}</b></span>
          <span><small>Faturamento</small><b>{money(data.totals.gross)}</b></span>
        </div>
      )}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {data && data.items.length === 0 && <p className="lsales-empty">Nenhuma venda sincronizada para este anúncio.</p>}
      {data && data.items.length > 0 && (
        <div className="lsales-wrap">
          <table className="lsales-table">
            <thead>
              <tr><th>Data</th><th>Pedido</th><th>Qtd</th><th>Valor</th><th>Tarifa</th><th>Frete</th><th>Margem</th><th>Status</th></tr>
            </thead>
            <tbody>
              {data.items.map((s) => (
                <tr key={`${s.orderId}-${s.orderedAt}`} data-status={s.status}>
                  <td>{new Date(s.orderedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                  <td><code>{s.orderId}</code></td>
                  <td>{s.quantity}</td>
                  <td>{money(s.gross)}</td>
                  <td>{money(s.fee)}</td>
                  <td>{money(s.freight)}</td>
                  <td data-tone={s.status === 'paid' && s.margin !== null ? marginTone(s.gross ? s.margin / s.gross : null) : undefined}>
                    {s.status !== 'paid' ? '—' : s.margin === null ? 'sem custo' : money(s.margin)}
                  </td>
                  <td>{STATUS[s.status]}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && last > 0 && (
        <div className="lsales-pager">
          <button type="button" className="act" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Anterior</button>
          <span>Página {page + 1} de {last + 1}</span>
          <button type="button" className="act" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima ›</button>
        </div>
      )}
      <p className="lprice-note">Tarifa, frete e imposto de pedidos com vários itens são divididos pelo valor de cada item.</p>
    </>
  );
}

function Months({ item }: { item: ListingDto }) {
  const [rows, setRows] = useState<ListingMonthDto[] | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    let alive = true;
    listingsApi
      .monthly(item.id)
      .then((r) => alive && setRows(r))
      .catch(() => alive && setError('Não foi possível carregar o resumo mensal.'));
    return () => {
      alive = false;
    };
  }, [item.id]);

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!rows) return <div className="promo-skel" aria-hidden="true" />;
  if (!rows.length) return <p className="lsales-empty">Nenhuma venda paga sincronizada para este anúncio.</p>;
  const max = Math.max(...rows.map((r) => r.gross), 1);
  return (
    <ul className="lmonths">
      {rows.map((r) => {
        const p = r.margin !== null && r.gross ? r.margin / r.gross : null;
        return (
          <li key={r.month}>
            <div className="lmonths-head">
              <strong>{monthLabel(r.month)}</strong>
              <span>{int(r.orders)} pedidos · {int(r.units)} un.</span>
            </div>
            <div className="lmonths-bar" aria-hidden="true"><span style={{ width: `${(r.gross / max) * 100}%` }} /></div>
            <dl>
              <div><dt>Faturamento</dt><dd>{money(r.gross)}</dd></div>
              <div><dt>Tarifa</dt><dd>{money(r.fee)}</dd></div>
              <div><dt>Frete</dt><dd>{money(r.freight)}</dd></div>
              <div><dt>Imposto</dt><dd>{money(r.tax)}</dd></div>
              <div><dt>Custo</dt><dd>{r.cost === null ? 'incompleto' : money(r.cost)}</dd></div>
              <div data-tone={marginTone(p)}>
                <dt>Margem</dt>
                <dd>{r.margin === null ? '—' : `${money(r.margin)} · ${pct(p ?? 0, 1)}`}</dd>
              </div>
            </dl>
          </li>
        );
      })}
    </ul>
  );
}
