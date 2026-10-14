import { useEffect, useState } from 'react';
import type { PlatformOverviewDto } from '@nvs/shared';
import { int, money } from '../../shared/format';
import { brDate, masterApi } from './master-api';

/** Visão geral da plataforma: empresas, assinaturas, receita recorrente e o que está em atraso. */
export function OverviewView({ go }: { go: (p: string) => void }) {
  const [o, setO] = useState<PlatformOverviewDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    masterApi.overview().then(setO).catch(() => setError('Não foi possível carregar.'));
  }, []);
  if (error) return <p className="banner banner-error">{error}</p>;
  if (!o) return <div className="promo-skel" aria-hidden="true" />;
  return (
    <div className="ms-page">
      <header className="ms-head">
        <div><p className="dash-kicker">Painel Master</p><h1>Visão geral</h1></div>
      </header>
      <section className="ms-kpis">
        <button type="button" className="ms-kpi ms-kpi-dark" onClick={() => go('/mensalidades')}>
          <small>Receita recorrente (MRR)</small><b>{money(o.mrr)}</b><span>assinaturas ativas e em atraso</span>
        </button>
        <button type="button" className="ms-kpi" onClick={() => go('/empresas')}>
          <small>Empresas</small><b>{int(o.tenants.total)}</b><span>{o.tenants.active} ativas · {o.tenants.suspended} suspensas · +{o.tenants.newLast30} em 30 dias</span>
        </button>
        <button type="button" className="ms-kpi ms-kpi-warn" onClick={() => go('/mensalidades')}>
          <small>Em atraso</small><b>{money(o.invoices.overdueTotal)}</b><span>{o.invoices.overdue} mensalidade(s) vencida(s)</span>
        </button>
        <div className="ms-kpi">
          <small>Recebido no mês</small><b>{money(o.invoices.paidThisMonth)}</b><span>{o.invoices.pending} a vencer ({money(o.invoices.pendingTotal)})</span>
        </div>
      </section>
      <section className="ms-two">
        <article className="ms-card">
          <h2>Assinaturas</h2>
          <ul className="ms-bars">
            {([['active', 'Ativas'], ['trial', 'Teste grátis'], ['past_due', 'Em atraso'], ['canceled', 'Canceladas'], ['none', 'Sem assinatura']] as const).map(([k, label]) => (
              <li key={k}><span>{label}</span><b>{o.subscriptions[k]}</b>
                <i style={{ width: `${o.tenants.total ? (100 * o.subscriptions[k]) / o.tenants.total : 0}%` }} data-k={k} /></li>
            ))}
          </ul>
          <p className="ms-sub">{o.tenants.mlConnected} empresa(s) com Mercado Livre conectado.</p>
        </article>
        <article className="ms-card">
          <h2>Últimos cadastros</h2>
          <ul className="ms-list">
            {o.recent.map((t) => (
              <li key={t.id}><button type="button" className="link" onClick={() => go(`/empresas/${t.id}`)}>{t.name}</button><small>{brDate(t.createdAt.slice(0, 10))}</small></li>
            ))}
          </ul>
        </article>
      </section>
    </div>
  );
}
