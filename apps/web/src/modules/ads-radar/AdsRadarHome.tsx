import { useMemo, useState } from 'react';
import type { AdCampaignDto, AdsRadarOverviewDto } from '@nvs/shared';
import { change, money } from '../../shared/format';
import { STATUS_LABEL, TONE_COLOR, fmtPct, fmtX } from './AdsRadarPanels';

type Filter = 'ativas' | 'atencao' | 'pausadas' | 'todas';
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ativas', label: 'Ativas' }, { id: 'atencao', label: 'Precisam de atenção' }, { id: 'pausadas', label: 'Pausadas' }, { id: 'todas', label: 'Todas' },
];

function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const vals = values.map((v) => v ?? 0);
  if (vals.length < 2 || vals.every((v) => v === 0)) return <span className="arh-spark-empty">—</span>;
  const max = Math.max(...vals, 0.0001);
  return (
    <svg className="arh-spark" viewBox={`0 0 ${(vals.length - 1) * 10} 30`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={vals.map((v, i) => `${i * 10},${28 - (v / max) * 26}`).join(' ')} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Tela inicial do Radar ADS: números da conta, atalho para o fluxo geral e a lista de campanhas (clique abre o fluxo dela). */
export function AdsRadarHome({
  overview: o, campaigns, onOpenCampaign, onOpenGeneral, onOpenGoals, onOpenEvents,
}: {
  overview: AdsRadarOverviewDto;
  campaigns: AdCampaignDto[];
  onOpenCampaign: (c: AdCampaignDto) => void;
  onOpenGeneral: () => void;
  onOpenGoals: () => void;
  onOpenEvents: () => void;
}) {
  const [filter, setFilter] = useState<Filter>('ativas');
  const [q, setQ] = useState('');
  const costDelta = change(o.last7.cost, o.prev7.cost);
  const generalRules = o.rules.filter((r) => r.scope !== 'campanha').length;

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    return campaigns
      .filter((c) =>
        filter === 'todas' ? true
        : filter === 'ativas' ? c.mlStatus === 'active'
        : filter === 'pausadas' ? c.mlStatus !== 'active'
        : c.mlStatus === 'active' && c.status !== 'ok')
      .filter((c) => !term || c.name.toLowerCase().includes(term))
      .sort((a, b) => b.last7.cost - a.last7.cost);
  }, [campaigns, filter, q]);
  const count = (f: Filter) => campaigns.filter((c) =>
    f === 'todas' ? true : f === 'ativas' ? c.mlStatus === 'active' : f === 'pausadas' ? c.mlStatus !== 'active' : c.mlStatus === 'active' && c.status !== 'ok').length;

  return (
    <div className="arh">
      <section className="arh-kpis" aria-label="Resumo dos últimos 7 dias">
        <div className="arh-kpi">
          <span>Investimento 7 dias</span>
          <b>{money(o.last7.cost)}</b>
          {costDelta !== null && <small data-up={costDelta > 0 || undefined}>{costDelta > 0 ? '▲' : '▼'} {Math.abs(Math.round(costDelta * 100))}% vs semana anterior</small>}
        </div>
        <div className="arh-kpi"><span>Vendas com Ads</span><b>{money(o.last7.adsSales)}</b><small>de {money(o.last7.totalSales)} no total</small></div>
        <div className="arh-kpi"><span>ACOS</span><b>{fmtPct(o.last7.acos)}</b><small>gasto ÷ vendas dos Ads</small></div>
        <div className="arh-kpi"><span>TACOS</span><b>{fmtPct(o.last7.tacos)}</b><small>gasto ÷ vendas totais</small></div>
        <div className="arh-kpi"><span>ROAS</span><b>{fmtX(o.last7.roas)}</b><small>quanto volta por R$ 1</small></div>
        <button type="button" className="arh-kpi" data-tone={o.unread ? 'estourado' : undefined} onClick={onOpenEvents}>
          <span>Alertas</span><b>{o.unread}</b><small>{o.unread ? 'não lidos · ver →' : 'nenhum novo'}</small>
        </button>
      </section>

      <section className="arh-cards">
        <button type="button" className="arh-card arh-general" onClick={onOpenGeneral}>
          <span className="arh-card-ico" aria-hidden="true">⌘</span>
          <div>
            <b>Fluxo geral da conta</b>
            <p>Regras e metas que valem para todas as campanhas de uma vez.</p>
            <small>{generalRules} regra{generalRules === 1 ? '' : 's'} geral{generalRules === 1 ? '' : 'is'} · {o.goals.length} meta{o.goals.length === 1 ? '' : 's'}</small>
          </div>
          <span className="arh-go">Abrir fluxo →</span>
        </button>
        <div className="arh-card arh-how">
          <b>Como usar</b>
          <ol>
            <li><i>1</i>Clique numa campanha abaixo para abrir o fluxo dela.</li>
            <li><i>2</i>Crie uma regra, por exemplo “ACOS de 7 dias acima de 15%”.</li>
            <li><i>3</i>O Radar confere a cada hora e avisa em Alertas quando a regra disparar.</li>
          </ol>
          <button type="button" className="ar-btn" onClick={onOpenGoals}>Definir metas de gasto</button>
        </div>
      </section>

      <section className="arh-list" aria-label="Campanhas">
        <div className="arh-list-head">
          <h2>Campanhas</h2>
          <div className="arh-filters" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>{f.label} <span>{count(f.id)}</span></button>
            ))}
          </div>
          <input className="arh-search" type="search" placeholder="Buscar campanha…" value={q} onChange={(e) => setQ(e.target.value)} />
        </div>

        {list.length ? (
          <div className="arh-table" role="table">
            <div className="arh-row arh-row-head" role="row">
              <span role="columnheader">Campanha</span><span role="columnheader">Situação</span><span role="columnheader">Gasto 7d</span>
              <span role="columnheader">ACOS</span><span role="columnheader">TACOS</span><span role="columnheader">ROAS</span>
              <span role="columnheader">TACOS 7d</span><span role="columnheader" />
            </div>
            {list.map((c) => {
              const tone = c.rules ? c.status : null;
              return (
                <button key={`${c.accountId}:${c.campaignId}`} type="button" className="arh-row" role="row" onClick={() => onOpenCampaign(c)}>
                  <span className="arh-name" role="cell">
                    <b>{c.name}</b>
                    <small>{c.mlStatus === 'active' ? 'Ativa' : 'Pausada'}{c.acosTarget !== null ? ` · alvo ACOS ${fmtPct(c.acosTarget)}` : ''}{c.budget !== null ? ` · ${money(c.budget)}/dia` : ''}</small>
                  </span>
                  <span role="cell" data-label="Situação">
                    {tone ? <span className="arh-pill" data-tone={tone}>{STATUS_LABEL[tone]}</span> : <span className="arh-pill">Sem regra</span>}
                  </span>
                  <span role="cell" data-label="Gasto 7d" className="arh-num">{money(c.last7.cost)}</span>
                  <span role="cell" data-label="ACOS" className="arh-num">{fmtPct(c.last7.acos)}</span>
                  <span role="cell" data-label="TACOS" className="arh-num">{fmtPct(c.last7.tacos)}</span>
                  <span role="cell" data-label="ROAS" className="arh-num">{fmtX(c.last7.roas)}</span>
                  <span role="cell" className="arh-trend"><Spark values={c.trend} color={tone ? TONE_COLOR[tone] : 'var(--blue)'} /></span>
                  <span role="cell" className="arh-open">{c.rules ? `${c.rules} regra${c.rules > 1 ? 's' : ''}` : 'Criar fluxo'} →</span>
                </button>
              );
            })}
          </div>
        ) : (
          <p className="arh-empty">{campaigns.length ? 'Nenhuma campanha neste filtro.' : 'Nenhuma campanha lida ainda. Clique em Atualizar para buscar no Mercado Ads.'}</p>
        )}
      </section>
    </div>
  );
}
