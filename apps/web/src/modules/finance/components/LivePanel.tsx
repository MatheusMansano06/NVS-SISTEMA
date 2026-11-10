import { useEffect, useState } from 'react';
import { marginBand, type FinanceSummaryDto } from '@nvs/shared';
import { int, money, pct } from '../../../shared/format';
import { shortDay } from '../dates';
import { financeApi, type FinanceFilters } from '../finance-api';

/** Painel do TikTok Shop só com as vendas feitas em live: totais do período e cada live com a sua margem. */
export function LivePanel({ filters }: { filters: FinanceFilters }) {
  const [data, setData] = useState<FinanceSummaryDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    const c = new AbortController();
    setData(null);
    setError('');
    financeApi
      .summary({ ...filters, canal: 'live' }, false, c.signal)
      .then(setData)
      .catch((err) => (err as Error).name !== 'AbortError' && setError('Não foi possível carregar as lives.'));
    return () => c.abort();
  }, [filters]);

  const k = data?.cards;
  return (
    <div className="live-panel">
      <header>
        <h2>Vendas em live</h2>
        <p>Só os pedidos feitos durante uma live no período do filtro. Anúncios não entram: o extrato do TikTok não diz para qual live foram.</p>
      </header>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {!data && !error && <div className="live-kpis"><div className="kpi skeleton" /><div className="kpi skeleton" /><div className="kpi skeleton" /></div>}
      {k && (
        <>
          <div className="live-kpis">
            <div><span>Faturado em live</span><b className="money">{money(k.vendasAprovadas)}</b><small>{int(k.qtdAprovadas)} pedidos · {int(k.unidades)} unid.</small></div>
            <div data-band={k.mcPct === null ? undefined : marginBand(k.mcPct)}>
              <span>Margem de contribuição</span>
              <b>{k.mcPct === null ? '—' : pct(k.mcPct / 100, 1)}</b>
              <small>{k.mcTotal === null ? 'cadastre os custos' : money(k.mcTotal)}</small>
            </div>
            <div><span>Tarifa TikTok</span><b className="money">{money(k.tarifa)}</b><small>{k.faturamento ? pct(k.tarifa / k.faturamento) : '0%'} do faturamento</small></div>
            <div><span>Ticket médio</span><b className="money">{money(k.ticketMedio)}</b><small>{data.lives.length} live(s)</small></div>
          </div>
          {data.lives.length === 0 ? (
            <p className="empty">Nenhuma venda em live no período.</p>
          ) : (
            <div className="live-table">
              <table>
                <thead>
                  <tr><th>Live</th><th className="num">Pedidos</th><th className="num">Unid.</th><th className="num">Faturado</th><th className="num">MC</th><th className="num">MC %</th></tr>
                </thead>
                <tbody>
                  {data.lives.map((l) => (
                    <tr key={l.roomId}>
                      <td><b>{shortDay(l.day)}</b> <small className="mono" title={l.roomId}>…{l.roomId.slice(-6)}</small></td>
                      <td className="num">{int(l.pedidos)}</td>
                      <td className="num">{int(l.unidades)}</td>
                      <td className="num money">{money(l.faturamento)}</td>
                      <td className="num money">{l.mc === null ? <small>sem custo</small> : money(l.mc)}</td>
                      <td className="num"><span className="live-band" data-band={l.mcPct === null ? undefined : marginBand(l.mcPct)}>{l.mcPct === null ? '—' : pct(l.mcPct / 100, 1)}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
