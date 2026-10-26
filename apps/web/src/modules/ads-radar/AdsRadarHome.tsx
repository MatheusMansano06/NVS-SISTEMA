import { useMemo, useState, type CSSProperties } from 'react';
import type { AdCampaignDto, AdDailyDto, AdsRadarOverviewDto } from '@nvs/shared';
import { change, money } from '../../shared/format';
import { STATUS_LABEL, TONE_COLOR, fmtPct, fmtX } from './AdsRadarPanels';

type Filter = 'ativas' | 'atencao' | 'pausadas' | 'todas';
type Sort = 'gasto' | 'acos' | 'roas' | 'nome';
type Period = 7 | 15 | 30;
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'ativas', label: 'Ativas' }, { id: 'atencao', label: 'Precisam de atenção' }, { id: 'pausadas', label: 'Pausadas' }, { id: 'todas', label: 'Todas' },
];
const inFilter = (c: AdCampaignDto, f: Filter) =>
  f === 'todas' ? true : f === 'ativas' ? c.mlStatus === 'active' : f === 'pausadas' ? c.mlStatus !== 'active' : c.mlStatus === 'active' && c.rules > 0 && c.status !== 'ok';

const short = (v: number) => (v >= 1000 ? `${(v / 1000).toLocaleString('pt-BR', { maximumFractionDigits: v >= 10_000 ? 0 : 1 })} mil` : v.toLocaleString('pt-BR', { maximumFractionDigits: 0 }));
const dayLabel = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;

function totals(days: AdDailyDto[]) {
  const cost = days.reduce((s, d) => s + d.cost, 0);
  const ads = days.reduce((s, d) => s + d.adsSales, 0);
  const total = days.reduce((s, d) => s + d.totalSales, 0);
  return { cost, ads, total, acos: ads ? (cost / ads) * 100 : null, tacos: total ? (cost / total) * 100 : null, roas: cost ? ads / cost : null };
}

function Delta({ now, before, inverse }: { now: number | null; before: number | null; inverse?: boolean }) {
  if (now === null || before === null) return null;
  const d = change(now, before);
  if (d === null || !Number.isFinite(d)) return null;
  const good = inverse ? d < 0 : d > 0;
  return <em className="arh-delta" data-good={good || undefined}>{d > 0 ? '▲' : '▼'} {Math.abs(Math.round(d * 100))}%</em>;
}

/** Gráfico do período: barras = vendas com Ads, linha = investimento (escala própria). Passar o mouse mostra o dia. */
function Chart({ days }: { days: AdDailyDto[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 720, H = 220, P = 28;
  const maxSales = Math.max(...days.map((d) => d.adsSales), 1);
  const maxCost = Math.max(...days.map((d) => d.cost), 1);
  const step = (W - P * 2) / days.length;
  const bar = Math.max(4, step * 0.56);
  const y = (v: number, max: number) => H - P - (v / max) * (H - P * 2);
  const line = days.map((d, i) => `${P + step * i + step / 2},${y(d.cost, maxCost)}`).join(' ');
  const h = hover === null ? null : days[hover]!;
  const tick = Math.ceil(days.length / 8);
  return (
    <div className="arh-chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label="Vendas com Ads e investimento por dia" onMouseLeave={() => setHover(null)}>
        <defs>
          <linearGradient id="arh-bar" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="var(--blue)" stopOpacity=".9" /><stop offset="1" stopColor="var(--blue)" stopOpacity=".35" /></linearGradient>
          <linearGradient id="arh-area" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stopColor="#7c5cff" stopOpacity=".22" /><stop offset="1" stopColor="#7c5cff" stopOpacity="0" /></linearGradient>
        </defs>
        {[0.25, 0.5, 0.75, 1].map((f) => <line key={f} x1={P} x2={W - P} y1={y(maxSales * f, maxSales)} y2={y(maxSales * f, maxSales)} className="arh-gridline" />)}
        {days.map((d, i) => (
          <g key={d.day} onMouseEnter={() => setHover(i)}>
            <rect x={P + step * i} y={P / 2} width={step} height={H - P} fill="transparent" />
            <rect
              x={P + step * i + (step - bar) / 2} y={y(d.adsSales, maxSales)} width={bar} height={Math.max(0, H - P - y(d.adsSales, maxSales))}
              rx={Math.min(6, bar / 2)} fill="url(#arh-bar)" opacity={hover === null || hover === i ? 1 : 0.45}
            />
          </g>
        ))}
        <polygon points={`${P + step / 2},${H - P} ${line} ${P + step * (days.length - 1) + step / 2},${H - P}`} fill="url(#arh-area)" pointerEvents="none" />
        <polyline points={line} fill="none" stroke="#7c5cff" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" pointerEvents="none" />
        {h && <circle cx={P + step * hover! + step / 2} cy={y(h.cost, maxCost)} r="5" fill="#fff" stroke="#7c5cff" strokeWidth="2.5" pointerEvents="none" />}
        {days.map((d, i) => (i === days.length - 1 || (i % tick === 0 && days.length - 1 - i >= tick / 2)) && (
          <text key={d.day} x={P + step * i + step / 2} y={H - 8} textAnchor="middle" className="arh-axis">{i === days.length - 1 ? 'Hoje' : dayLabel(d.day)}</text>
        ))}
        <text x={P} y={P / 2 + 2} className="arh-axis">{short(maxSales)}</text>
      </svg>
      {h && (
        <div className="arh-tip" style={{ left: `${((P + step * hover! + step / 2) / W) * 100}%` }}>
          <b>{hover === days.length - 1 ? 'Hoje' : dayLabel(h.day)}</b>
          <span><i style={{ background: 'var(--blue)' }} />Vendas com Ads {money(h.adsSales)}</span>
          <span><i style={{ background: '#7c5cff' }} />Investimento {money(h.cost)}</span>
          <span>ACOS {fmtPct(h.acos)} · TACOS {fmtPct(h.tacos)}</span>
        </div>
      )}
      <div className="arh-legend"><span><i style={{ background: 'var(--blue)' }} />Vendas com Ads</span><span><i style={{ background: '#7c5cff' }} />Investimento</span></div>
    </div>
  );
}

function Spark({ values, color }: { values: (number | null)[]; color: string }) {
  const vals = values.map((v) => v ?? 0);
  if (vals.length < 2 || vals.every((v) => v === 0)) return null;
  const max = Math.max(...vals, 0.0001);
  const pts = vals.map((v, i) => `${i * 10},${30 - (v / max) * 26}`).join(' ');
  return (
    <svg className="arc-spark" viewBox={`0 0 ${(vals.length - 1) * 10} 32`} preserveAspectRatio="none" aria-hidden="true">
      <polygon points={`0,32 ${pts} ${(vals.length - 1) * 10},32`} fill={color} opacity=".12" />
      <polyline points={pts} fill="none" stroke={color} strokeWidth="2" vectorEffect="non-scaling-stroke" strokeLinejoin="round" />
    </svg>
  );
}

/** Fotos dos anúncios da campanha: 1 grande, ou mosaico de até 4. */
function Mosaic({ c }: { c: AdCampaignDto }) {
  const t = c.thumbnails;
  return (
    <div className="arc-media" data-n={Math.min(t.length, 4)}>
      {t.length ? t.slice(0, 4).map((src, i) => <img key={i} src={src.replace(/^http:/, 'https:')} alt="" loading="lazy" />) : <span className="arc-noimg">Sem fotos ainda</span>}
      {c.items > 4 && <span className="arc-more">+{c.items - 4}</span>}
    </div>
  );
}

function CampaignCard({ c, onOpen }: { c: AdCampaignDto; onOpen: () => void }) {
  const tone = c.rules ? c.status : null;
  const acosTone = c.last7.acos === null || c.acosTarget === null ? undefined : c.last7.acos > c.acosTarget ? 'bad' : 'ok';
  return (
    <button type="button" className="arc" data-paused={c.mlStatus !== 'active' || undefined} onClick={onOpen}>
      <Mosaic c={c} />
      <div className="arc-badges">
        {tone ? <span className="arh-pill" data-tone={tone}>{STATUS_LABEL[tone]}</span> : <span className="arh-pill">Sem regra</span>}
        {c.mlStatus !== 'active' && <span className="arh-pill">Pausada</span>}
      </div>
      <div className="arc-body">
        <div className="arc-head">
          <b>{c.name}</b>
          <small>{c.items} anúncio{c.items === 1 ? '' : 's'}{c.budget !== null ? ` · ${money(c.budget)}/dia` : ''}</small>
        </div>
        <div className="arc-main">
          <div><small>Gasto 7 dias</small><b>{money(c.last7.cost)}</b></div>
          <div><small>Vendas com Ads</small><b>{money(c.last7.adsSales)}</b></div>
        </div>
        <dl className="arc-stats">
          <div data-tone={acosTone} title={c.acosTarget !== null ? `Alvo de ACOS no ML: ${fmtPct(c.acosTarget)}` : undefined}>
            <dt>ACOS</dt><dd>{fmtPct(c.last7.acos)}</dd>{c.acosTarget !== null && <small>alvo {fmtPct(c.acosTarget)}</small>}
          </div>
          <div><dt>ROAS</dt><dd>{fmtX(c.last7.roas)}</dd></div>
          <div><dt>TACOS</dt><dd>{fmtPct(c.last7.tacos)}</dd></div>
        </dl>
        <Spark values={c.trend} color={tone ? TONE_COLOR[tone] : 'var(--blue)'} />
        <span className="arc-go" data-has={c.rules > 0 || undefined}>{c.rules ? `${c.rules} regra${c.rules > 1 ? 's' : ''} · abrir fluxo` : 'Criar fluxo'} →</span>
      </div>
    </button>
  );
}

/** Tela inicial do Radar ADS: painel do período, atalhos (fluxo geral, alertas, metas) e as campanhas em cartões. */
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
  const [period, setPeriod] = useState<Period>(7);
  const [filter, setFilter] = useState<Filter>('ativas');
  const [sort, setSort] = useState<Sort>('gasto');
  const [q, setQ] = useState('');
  const days = o.daily.slice(-period);
  const now = totals(days);
  const prev = o.daily.length >= period * 2 ? totals(o.daily.slice(-period * 2, -period)) : null;
  const adsShare = now.total ? Math.round((now.ads / now.total) * 100) : 0;
  const generalRules = o.rules.filter((r) => r.scope !== 'campanha').length;
  const month = o.goals.find((g) => g.kind === 'gasto_mes');

  const list = useMemo(() => {
    const term = q.trim().toLowerCase();
    const by: Record<Sort, (a: AdCampaignDto, b: AdCampaignDto) => number> = {
      gasto: (a, b) => b.last7.cost - a.last7.cost,
      acos: (a, b) => (b.last7.acos ?? -1) - (a.last7.acos ?? -1),
      roas: (a, b) => (b.last7.roas ?? -1) - (a.last7.roas ?? -1),
      nome: (a, b) => a.name.localeCompare(b.name),
    };
    return campaigns.filter((c) => inFilter(c, filter) && (!term || c.name.toLowerCase().includes(term))).sort(by[sort]);
  }, [campaigns, filter, sort, q]);

  return (
    <div className="arh">
      <section className="arh-dash">
        <div className="arh-dash-head">
          <div>
            <h2>Desempenho dos Ads</h2>
            <p>{o.campaigns.total} campanhas ativas · {period === 7 ? 'últimos 7 dias' : `últimos ${period} dias`}, hoje incluso</p>
          </div>
          <div className="arh-seg" role="tablist" aria-label="Período">
            {([7, 15, 30] as const).map((p) => <button key={p} type="button" role="tab" aria-selected={period === p} onClick={() => setPeriod(p)}>{p} dias</button>)}
          </div>
        </div>
        <div className="arh-tiles">
          <div className="arh-tile" data-c="blue"><span>Investimento</span><b>{money(now.cost)}</b><Delta now={now.cost} before={prev?.cost ?? null} inverse /></div>
          <div className="arh-tile" data-c="sky"><span>Vendas com Ads</span><b>{money(now.ads)}</b><Delta now={now.ads} before={prev?.ads ?? null} /></div>
          <div className="arh-tile" data-c="violet"><span>ROAS</span><b>{fmtX(now.roas)}</b><small>a cada R$ 1 investido</small></div>
          <div className="arh-tile" data-c="mint"><span>ACOS</span><b>{fmtPct(now.acos)}</b><small>gasto ÷ vendas com Ads</small></div>
          <div className="arh-tile" data-c="sun"><span>TACOS</span><b>{fmtPct(now.tacos)}</b><small>gasto ÷ todas as vendas</small></div>
        </div>
        <div className="arh-dash-body">
          <Chart days={days} />
          <div className="arh-share">
            <span>De onde vêm as vendas</span>
            <div className="arh-ring" style={{ '--p': adsShare } as CSSProperties}><b>{adsShare}%</b><small>com Ads</small></div>
            <ul>
              <li><i style={{ background: 'var(--blue)' }} />Com Ads <b>{money(now.ads)}</b></li>
              <li><i style={{ background: 'var(--gray-300)' }} />Sem Ads <b>{money(Math.max(0, now.total - now.ads))}</b></li>
            </ul>
          </div>
        </div>
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
        <button type="button" className="arh-card arh-mini" data-tone={o.unread ? 'estourado' : undefined} onClick={onOpenEvents}>
          <span>Alertas</span><b>{o.unread}</b><small>{o.unread ? 'não lidos · ver →' : 'nenhum alerta novo'}</small>
        </button>
        <button type="button" className="arh-card arh-mini" onClick={onOpenGoals}>
          <span>Meta do mês</span>
          {month ? (
            <>
              <b>{money(month.current ?? 0)}</b>
              <div className="arh-bar"><i style={{ width: `${Math.min(100, ((month.current ?? 0) / month.target) * 100)}%` }} /></div>
              <small>de {money(month.target)}</small>
            </>
          ) : <><b className="arh-plus">+</b><small>defina quanto quer gastar no mês</small></>}
        </button>
      </section>

      <section className="arh-list" aria-label="Campanhas">
        <div className="arh-list-head">
          <h2>Campanhas</h2>
          <div className="arh-filters" role="tablist">
            {FILTERS.map((f) => (
              <button key={f.id} type="button" role="tab" aria-selected={filter === f.id} onClick={() => setFilter(f.id)}>
                {f.label} <span>{campaigns.filter((c) => inFilter(c, f.id)).length}</span>
              </button>
            ))}
          </div>
          <div className="arh-tools">
            <select className="arh-select" value={sort} onChange={(e) => setSort(e.target.value as Sort)} aria-label="Ordenar">
              <option value="gasto">Maior gasto</option><option value="acos">Maior ACOS</option><option value="roas">Maior ROAS</option><option value="nome">Nome</option>
            </select>
            <input className="arh-search" type="search" placeholder="Buscar campanha…" value={q} onChange={(e) => setQ(e.target.value)} />
          </div>
        </div>
        {list.length ? (
          <div className="arc-grid">{list.map((c) => <CampaignCard key={`${c.accountId}:${c.campaignId}`} c={c} onOpen={() => onOpenCampaign(c)} />)}</div>
        ) : (
          <p className="arh-empty">{campaigns.length ? 'Nenhuma campanha neste filtro.' : 'Nenhuma campanha lida ainda. Clique em Atualizar para buscar no Mercado Ads.'}</p>
        )}
      </section>
    </div>
  );
}
