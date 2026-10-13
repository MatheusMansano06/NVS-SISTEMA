import { useCallback, useEffect, useState } from 'react';
import { type FlexDashboardDto, type FlexOpportunitiesDto, type FreightRadarDto, type FreightRadarItemDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { navigate } from '../../app/router';
import { int, money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { useAuth } from '../auth/AuthContext';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { HowTo } from '../listings/ListingsNav';
import { listingsApi } from '../listings/listings-api';
import { freightApi } from './freight-api';
import '../skus/skus.css';
import '../listings/listings.css';
import '../sales/sales.css';
import './freight.css';

const STEPS = [
  { title: 'O que é', text: 'Todo dia o sistema lê quanto o ML cobra de frete em cada anúncio com frete grátis e guarda.' },
  { title: 'Quando alerta', text: 'Se o frete subir 30% ou mais (e pelo menos R$ 3), o anúncio aparece aqui com a margem antes e depois.' },
  { title: 'O que fazer', text: 'Confira as medidas (a causa mais comum), ajuste o preço no Precificador ou ative o Flex.' },
];

const dateBr = (d: string | null) => (d ? new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR') : '—');

/** Radar de Frete: altas de frete cobradas pelo ML e onde o Flex vale a pena. */
export function FreightPage() {
  const [tab, setTab] = useState<'radar' | 'flex' | 'painel'>(() => {
    const a = new URLSearchParams(window.location.search).get('aba');
    return a === 'flex' || a === 'painel' ? a : 'radar';
  });
  const [radar, setRadar] = useState<FreightRadarDto | null>(null);
  const tour = useGuidedTour('radar', TOURS.radar, radar !== null);
  return (
    <AppShell>
      <div className="skus freight">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Radar de Frete</h1>
          </div>
          <div className="seg" role="tablist" aria-label="Radar">
            <button type="button" role="tab" aria-checked={tab === 'radar'} onClick={() => setTab('radar')}>
              Altas de frete {radar && <span>{radar.alerts.length}</span>}
            </button>
            <button type="button" role="tab" aria-checked={tab === 'painel'} onClick={() => setTab('painel')}>Painel Flex</button>
            <button type="button" role="tab" aria-checked={tab === 'flex'} onClick={() => setTab('flex')}>Oportunidades de Flex</button>
          </div>
        </header>
        <HowTo steps={STEPS} storageKey="nvs:howto:radar" onTour={tour.start} />
        {tab === 'radar' ? <Radar data={radar} onData={setRadar} /> : tab === 'painel' ? <FlexPanel /> : <Opportunities />}
      </div>
      {tour.element}
    </AppShell>
  );
}

function Radar({ data, onData }: { data: FreightRadarDto | null; onData: (d: FreightRadarDto) => void }) {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [reading, setReading] = useState(false);

  const load = useCallback(() => {
    freightApi
      .radar()
      .then(onData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o radar.'));
  }, [onData]);
  useEffect(load, [load]);

  async function readNow() {
    setReading(true);
    setMsg('');
    try {
      const r = await freightApi.refresh();
      setMsg(`${int(r.read)} anúncios lidos agora.`);
      load();
    } catch (err) {
      setMsg(err instanceof ApiError ? err.message : 'Não foi possível ler agora.');
    } finally {
      setReading(false);
    }
  }

  const impact = data?.alerts.reduce((s, a) => s + (a.monthlyImpact ?? 0), 0) ?? 0;
  return (
    <>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {data && (
        <section className="skpis radar-kpis" aria-label="Resumo">
          <div data-tone={data.alerts.length ? 'bad' : 'ok'}>
            <small>Altas de frete</small>
            <b>{int(data.alerts.length)}</b>
            <span>{data.alerts.length ? 'precisam de atenção' : 'nenhuma alta relevante'}</span>
          </div>
          <div data-tone={impact > 0 ? 'bad' : undefined}>
            <small>Custo a mais por mês</small>
            <b>{money(impact)}</b>
            <span>no volume de vendas atual</span>
          </div>
          <div><small>Anúncios monitorados</small><b>{int(data.monitored)}</b><span>com frete grátis</span></div>
          <div>
            <small>Última leitura</small>
            <b>{dateBr(data.lastReading)}</b>
            {canManage && (
              <button type="button" className="link" disabled={reading} onClick={() => void readNow()}>
                {reading ? 'Lendo…' : 'Ler agora'}
              </button>
            )}
          </div>
        </section>
      )}
      {msg && <p className="banner banner-ok" role="status">{msg}</p>}
      {data && !data.monitored && (
        <div className="skus-empty">
          <strong>Ainda sem leituras</strong>
          <p>A primeira leitura acontece hoje de madrugada (05:00). Se quiser já, clique em “Ler agora”.</p>
        </div>
      )}
      {data && data.alerts.length > 0 && (
        <section className="radar-list" aria-label="Altas de frete">
          {data.alerts.map((a) => <RadarCard key={a.id} item={a} canManage={canManage} alert />)}
        </section>
      )}
      {data && data.heavy.length > 0 && (
        <>
          <h2 className="radar-sub">Frete pesando na margem <small>(20% ou mais do preço)</small></h2>
          <section className="radar-list">
            {data.heavy.map((a) => <RadarCard key={a.id} item={a} canManage={canManage} />)}
          </section>
        </>
      )}
    </>
  );
}

function Spark({ points }: { points: { day: string; cost: number }[] }) {
  if (points.length < 2) return null;
  const w = 120;
  const h = 32;
  const max = Math.max(...points.map((p) => p.cost));
  const min = Math.min(...points.map((p) => p.cost));
  const span = max - min || 1;
  const d = points
    .map((p, i) => `${i ? 'L' : 'M'}${((i / (points.length - 1)) * w).toFixed(1)},${(h - 4 - ((p.cost - min) / span) * (h - 8)).toFixed(1)}`)
    .join(' ');
  return (
    <svg className="radar-spark" viewBox={`0 0 ${w} ${h}`} width={w} height={h} aria-label="Frete nos últimos 30 dias">
      <path d={d} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

function RadarCard({ item, canManage, alert }: { item: FreightRadarItemDto; canManage: boolean; alert?: boolean }) {
  const [flex, setFlex] = useState(item.flex);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const up = item.reference !== null ? item.current - item.reference : null;
  return (
    <article className="radar-card" data-alert={alert || undefined}>
      <ProductThumb src={item.pictureUrl} alt={item.title} />
      <div className="radar-main">
        <strong>{item.sku ?? item.id}</strong>
        <span className="radar-title" title={item.title}>{item.title}</span>
        <span className="radar-meta">
          {item.id} · {item.price === null ? '—' : money(item.price)} · {int(item.units30d)} un. vendidas/30d
          {item.full && <span className="tag tag-full">FULL</span>}
          {flex && <span className="tag tag-flex">FLEX</span>}
        </span>
      </div>
      <div className="radar-freight">
        <small>Frete que você paga</small>
        <b>
          {item.reference !== null && <s>{money(item.reference)}</s>} {money(item.current)}
        </b>
        <span>
          {up !== null && item.reference ? `${up >= 0 ? '+' : ''}${money(up)} (${pct(up / item.reference, 0)})` : ''}
          {item.referenceSource === 'sales' ? ' vs. média paga nas vendas' : item.since ? ` desde ${dateBr(item.since)}` : ''}
        </span>
        {item.discount !== null && (
          <span className="radar-list-cost">tabela ML {money(item.currentList)} · seu desconto {pct(item.discount, 0)}</span>
        )}
        <Spark points={item.history} />
      </div>
      <div className="radar-margin">
        <small>Margem por venda</small>
        <b>
          {item.marginBefore !== null && <s>{money(item.marginBefore)}</s>} {item.marginAfter === null ? '—' : money(item.marginAfter)}
        </b>
        <span>
          {item.monthlyImpact ? `${money(item.monthlyImpact)} a mais por mês` : item.freightPct !== null ? `frete = ${pct(item.freightPct, 0)} do preço` : ''}
        </span>
      </div>
      <div className="radar-actions">
        <button type="button" className="act" onClick={() => navigate(`/anuncios?editar=${item.id}&aba=dimensions`)} title={item.dimensions ?? undefined}>
          Conferir medidas
        </button>
        <button type="button" className="act" onClick={() => navigate(`/precificador?anuncio=${item.id}`)}>Precificador</button>
        {canManage && !flex && (
          <button
            type="button"
            className="act act-strong"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              setErr('');
              try {
                await listingsApi.setFlex(item.id, true);
                setFlex(true);
              } catch (e) {
                setErr(e instanceof ApiError ? e.message : 'Não foi possível ativar o Flex.');
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? 'Ativando…' : 'Ativar Flex'}
          </button>
        )}
      </div>
      {err && <p className="sku-error">{err}</p>}
    </article>
  );
}

function Opportunities() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [data, setData] = useState<FlexOpportunitiesDto | null>(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [done, setDone] = useState<Set<string>>(new Set());
  const [progress, setProgress] = useState<string>('');

  useEffect(() => {
    freightApi
      .opportunities()
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar as oportunidades.'));
  }, []);

  async function activate(ids: string[]) {
    const fails: string[] = [];
    for (const [i, id] of ids.entries()) {
      setProgress(`Ativando ${i + 1} de ${ids.length}…`);
      try {
        await listingsApi.setFlex(id, true);
        setDone((d) => new Set(d).add(id));
      } catch (e) {
        fails.push(`${id}: ${e instanceof ApiError ? e.message : 'erro'}`);
      }
    }
    setSelected(new Set());
    setProgress(fails.length ? `Concluído com ${fails.length} erro(s): ${fails.join(' · ')}` : `Flex ativado em ${ids.length} anúncio(s).`);
  }

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  if (!data) return <div className="promo-skel" aria-hidden="true" />;
  if (data.method === 'none') {
    return (
      <div className="skus-empty">
        <strong>Sua conta ainda não usa Flex</strong>
        <p>Habilite o Flex na conta do Mercado Livre e configure a área de entrega. Depois eu mostro aqui quais anúncios mais vendem dentro dela.</p>
      </div>
    );
  }
  const pending = data.items.filter((i) => !done.has(i.id));
  return (
    <>
      <p className="ledit-hint">
        {data.method === 'zones'
          ? `Vendas dos últimos 90 dias entregues dentro das suas zonas de Flex (${data.areaLabel}).`
          : `Sua conta usa raio: comparamos com as vendas para ${data.areaLabel}, a cidade de origem.`}{' '}
        Com Flex, esses compradores veem entrega no mesmo dia — costuma aumentar a conversão.
      </p>
      {canManage && pending.length > 0 && (
        <div className="opp-bar">
          <label className="ledit-check">
            <input
              type="checkbox"
              checked={selected.size === pending.length}
              onChange={(e) => setSelected(e.target.checked ? new Set(pending.map((p) => p.id)) : new Set())}
            />
            Selecionar todos ({pending.length})
          </label>
          <button type="button" className="act act-strong" disabled={!selected.size} onClick={() => void activate([...selected])}>
            Ativar Flex nos selecionados ({selected.size})
          </button>
          {progress && <span>{progress}</span>}
        </div>
      )}
      {!data.items.length && (
        <div className="skus-empty"><strong>Nada por aqui 🎉</strong><p>Os anúncios que vendem na sua área já têm Flex (ou ainda não há vendas localizadas).</p></div>
      )}
      <ul className="opp-list">
        {data.items.map((o) => (
          <li key={o.id} data-done={done.has(o.id) || undefined}>
            {canManage && !done.has(o.id) && (
              <input
                type="checkbox"
                aria-label={`Selecionar ${o.sku ?? o.id}`}
                checked={selected.has(o.id)}
                onChange={(e) => {
                  const n = new Set(selected);
                  if (e.target.checked) n.add(o.id);
                  else n.delete(o.id);
                  setSelected(n);
                }}
              />
            )}
            <ProductThumb src={o.pictureUrl} alt={o.title} />
            <div className="radar-main">
              <strong>{o.sku ?? o.id}</strong>
              <span className="radar-title">{o.title}</span>
            </div>
            <div className="opp-num"><small>Vendas na sua área</small><b>{int(o.ordersInArea)}</b><span>{int(o.unitsInArea)} un.</span></div>
            <div className="opp-num"><small>Das vendas do anúncio</small><b>{pct(o.shareInArea, 0)}</b><span>caem na área</span></div>
            {done.has(o.id) ? (
              <span className="tag tag-flex">FLEX ativado</span>
            ) : (
              canManage && <button type="button" className="act act-strong" onClick={() => void activate([o.id])}>Ativar Flex</button>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

const MONTHS = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
const monthLabel = (m: string) => `${MONTHS[Number(m.slice(5, 7)) - 1]}/${m.slice(2, 4)}`;

/** Painel Flex: quanto das vendas sai por Flex e para onde. */
function FlexPanel() {
  const [days, setDays] = useState(30);
  const [data, setData] = useState<FlexDashboardDto | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setData(null);
    freightApi
      .flexDashboard(days)
      .then(setData)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Não foi possível carregar o painel.'));
  }, [days]);

  if (error) return <p className="banner banner-error" role="alert">{error}</p>;
  const share = data && data.total.gross ? data.flex.gross / data.total.gross : 0;
  const maxMonth = Math.max(1, ...(data?.monthly.map((m) => m.gross) ?? []));
  const maxCity = Math.max(1, ...(data?.cities.map((c) => c.orders) ?? []));
  return (
    <>
      <div className="fpanel-head">
        <p className="ledit-hint">Vendas pagas entregues por Flex (você mesmo entrega, no mesmo dia), comparadas com todas as vendas.</p>
        <div className="seg seg-sm" role="tablist" aria-label="Período">
          {[30, 90, 180].map((d) => (
            <button key={d} type="button" role="tab" aria-checked={days === d} onClick={() => setDays(d)}>{d} dias</button>
          ))}
        </div>
      </div>
      {!data ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : (
        <>
          <section className="skpis fpanel-kpis" aria-label="Resumo Flex">
            <div data-tone="ok">
              <small>Vendido por Flex</small>
              <b>{money(data.flex.gross)}</b>
              <span>{int(data.flex.orders)} pedidos · {int(data.flex.units)} un.</span>
            </div>
            <div>
              <small>Participação do Flex</small>
              <b>{pct(share, 1)}</b>
              <span>do faturamento ({pct(data.total.orders ? data.flex.orders / data.total.orders : 0, 0)} dos pedidos)</span>
            </div>
            <div>
              <small>Total de vendas</small>
              <b>{money(data.total.gross)}</b>
              <span>{int(data.total.orders)} pedidos</span>
            </div>
            <div>
              <small>Ticket médio Flex</small>
              <b>{data.flex.orders ? money(data.flex.gross / data.flex.orders) : '—'}</b>
              <span>por pedido</span>
            </div>
          </section>

          <div className="fpanel-grid">
            <section className="fpanel-box" aria-label="Mês a mês">
              <h2>Mês a mês</h2>
              <div className="fpanel-bars">
                {data.monthly.map((m) => (
                  <div key={m.month} className="fpanel-bar" title={`${monthLabel(m.month)}: ${money(m.flexGross)} de ${money(m.gross)}`}>
                    <span className="fpanel-col" style={{ height: `${(m.gross / maxMonth) * 100}%` }}>
                      <i style={{ height: `${m.gross ? (m.flexGross / m.gross) * 100 : 0}%` }} />
                    </span>
                    <b>{m.gross ? pct(m.flexGross / m.gross, 0) : '—'}</b>
                    <small>{monthLabel(m.month)}</small>
                  </div>
                ))}
              </div>
              <p className="fpanel-legend"><i /> Flex <i data-all /> Todas as vendas</p>
            </section>

            <section className="fpanel-box" aria-label="Cidades que mais compram por Flex">
              <h2>Onde mais vende Flex</h2>
              {!data.cities.length ? (
                <p className="fpanel-empty">Sem vendas Flex com cidade conhecida no período.</p>
              ) : (
                <ol className="fpanel-rank">
                  {data.cities.map((c) => (
                    <li key={`${c.city}-${c.uf}`}>
                      <span className="fpanel-name">{c.city}{c.uf ? ` · ${c.uf}` : ''}</span>
                      <span className="fpanel-track"><i style={{ width: `${(c.orders / maxCity) * 100}%` }} /></span>
                      <b>{int(c.orders)}</b>
                      <small>{money(c.gross)} · {pct(c.share, 0)} das vendas da cidade</small>
                    </li>
                  ))}
                </ol>
              )}
              {data.unlocated > 0 && <p className="fpanel-empty">+ {int(data.unlocated)} vendas Flex com endereço ainda em leitura.</p>}
            </section>

            {data.zones.length > 0 && (
              <section className="fpanel-box" aria-label="Zonas de Flex">
                <h2>Suas zonas de Flex</h2>
                <ol className="fpanel-rank">
                  {data.zones.map((z) => (
                    <li key={z.label}>
                      <span className="fpanel-name">{z.label}</span>
                      <span className="fpanel-track"><i style={{ width: `${(z.orders / Math.max(1, data.zones[0]!.orders)) * 100}%` }} /></span>
                      <b>{int(z.orders)}</b>
                      <small>{money(z.gross)}</small>
                    </li>
                  ))}
                </ol>
              </section>
            )}

            <section className="fpanel-box" aria-label="Anúncios mais vendidos no Flex">
              <h2>Mais vendidos no Flex</h2>
              {!data.topListings.length ? (
                <p className="fpanel-empty">Nenhuma venda Flex no período.</p>
              ) : (
                <ul className="fpanel-top">
                  {data.topListings.map((t) => (
                    <li key={t.id}>
                      <ProductThumb src={t.pictureUrl} alt={t.title} />
                      <div className="radar-main">
                        <strong>{t.sku ?? t.id}</strong>
                        <span className="radar-title" title={t.title}>{t.title}</span>
                      </div>
                      <div className="opp-num"><b>{int(t.orders)}</b><span>{money(t.gross)}</span></div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}
    </>
  );
}
