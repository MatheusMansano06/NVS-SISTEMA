import { useEffect, useState } from 'react';
import type { ListingDto, ListingSalesDto } from '@nvs/shared';
import { int, money } from '../../shared/format';
import { listingsApi } from './listings-api';

const STATUS = { paid: 'Paga', cancelled: 'Cancelada', returned: 'Devolvida' } as const;
const PAGE = 15;

/** Histórico de vendas do anúncio (pedidos já sincronizados, sem consultar o marketplace). */
export function ListingSalesModal({ item }: { item: ListingDto }) {
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
    <div className="lsales">
      <h2>Vendas do anúncio</h2>
      <p className="lprice-sub">{item.title}</p>
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
        <div className="lsales-wrap"><table className="lsales-table">
          <thead><tr><th>Data</th><th>Pedido</th><th>Qtd</th><th>Valor</th><th>Status</th></tr></thead>
          <tbody>
            {data.items.map((s) => (
              <tr key={`${s.orderId}-${s.orderedAt}`} data-status={s.status}>
                <td>{new Date(s.orderedAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td><code>{s.orderId}</code></td>
                <td>{s.quantity}</td>
                <td>{money(s.gross)}</td>
                <td>{STATUS[s.status]}</td>
              </tr>
            ))}
          </tbody>
        </table></div>
      )}
      {data && last > 0 && (
        <div className="lsales-pager">
          <button type="button" className="act" disabled={page === 0} onClick={() => setPage(page - 1)}>‹ Anterior</button>
          <span>Página {page + 1} de {last + 1}</span>
          <button type="button" className="act" disabled={page >= last} onClick={() => setPage(page + 1)}>Próxima ›</button>
        </div>
      )}
    </div>
  );
}
