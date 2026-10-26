import { useEffect, useMemo, useRef, useState } from 'react';
import { ABC_CLASSES, ABC_LIMITS, ABC_PERIODS, ABC_PERIOD_DAYS, type AbcClass, type AbcCurveDto, type AbcMetric, type AbcPeriod } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { int, money, pct } from '../../shared/format';
import { Hint } from '../../shared/ui/Hint';
import { useGuidedTour } from '../../shared/tour/Tour';
import { TOURS } from '../../shared/tour/tours';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { HowTo } from '../listings/ListingsNav';
import { abcApi } from './abc-api';
import '../skus/skus.css';
import '../listings/listings.css';
import '../sales/sales.css';
import './abc.css';

const STEPS = [
  { title: 'Escolha o período', text: 'A curva usa só as vendas pagas do período: 30, 60 ou 90 dias.' },
  { title: 'Faturamento ou unidades', text: 'Em reais mostra quem traz o dinheiro; em unidades, quem mais gira no estoque. Os dois costumam ser diferentes.' },
  { title: 'Cuide dos A', text: 'Poucos anúncios fazem a maior parte das vendas. Clique numa classe para ver só os anúncios dela.' },
];

const METRIC_LABEL: Record<AbcMetric, string> = { revenue: 'Por faturamento', units: 'Por unidades' };
const CLASS_TEXT: Record<AbcClass, { name: string; hint: string }> = {
  A: { name: 'Campeões', hint: `Os que mais vendem: somados, chegam a ${ABC_LIMITS.A}% do total. Nunca deixe faltar estoque nem perder posição.` },
  B: { name: 'Intermediários', hint: `Os seguintes da fila, que levam o acumulado de ${ABC_LIMITS.A}% até ${ABC_LIMITS.B}%. Com um empurrão (preço, Ads, fotos) podem virar A.` },
  C: { name: 'Cauda', hint: `Todo o resto: juntos são só os últimos ${100 - ABC_LIMITS.B}%. Vale revisar preço, fotos ou se o anúncio ainda compensa.` },
};
const PAGE = 50;

const norm = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const share = (n: number) => (n > 0 && n < 0.001 ? '<0,1%' : pct(n, 1));
const day = (iso: string) => new Date(`${iso}T12:00:00`).toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });

/** Curva ABC dos anúncios do Mercado Livre: quem traz o faturamento e quem gira mais unidades. */
export function AbcPage() {
  const [period, setPeriod] = useState<AbcPeriod>('30d');
  const [metric, setMetric] = useState<AbcMetric>('revenue');
  const [cls, setCls] = useState<AbcClass | null>(null);
  const [q, setQ] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const [data, setData] = useState<AbcCurveDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError('');
    abcApi
      .curve(period, c.signal)
      .then(setData)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError('Não foi possível carregar a Curva ABC.');
      })
      .finally(() => {
        if (ctrl.current === c) setLoading(false);
      });
    return () => c.abort();
  }, [period]);
  useEffect(() => setLimit(PAGE), [period, metric, cls, q]);

  const by = metric === 'revenue' ? 'byRevenue' : 'byUnits';
  const sorted = useMemo(() => (data ? [...data.items].sort((a, b) => a[by].rank - b[by].rank) : []), [data, by]);
  const term = norm(q.trim());
  const shown = sorted.filter((i) => (!cls || i[by].class === cls) && (!term || norm(i.title).includes(term) || i.listingId.toLowerCase().includes(term)));
  const summary = data?.summary[metric];
  const total = data ? data.totals.listings : 0;
  const fmt = (v: number) => (metric === 'revenue' ? money(v) : `${int(v)} un.`);
  const what = metric === 'revenue' ? 'do faturamento' : 'das unidades';

  const tour = useGuidedTour('curva-abc', TOURS.abc, Boolean(data) && !loading);

  return (
    <AppShell>
      <div className="skus abc" aria-busy={loading}>
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>
              Curva ABC{' '}
              <Hint label="Curva ABC">
                Coloca seus anúncios em fila, do que mais vende para o que menos vende, e separa em 3 grupos (A, B e C). Quase sempre poucos anúncios trazem a maior parte do dinheiro — são eles que merecem mais cuidado.
              </Hint>
            </h1>
            {data && <p className="abc-range">Vendas pagas de {day(data.range.from)} a {day(data.range.to)}</p>}
          </div>
          <div className="seg abc-period" role="radiogroup" aria-label="Período">
            {ABC_PERIODS.map((p) => (
              <button key={p} type="button" role="radio" aria-checked={period === p} onClick={() => setPeriod(p)}>{ABC_PERIOD_DAYS[p]} dias</button>
            ))}
          </div>
        </header>
        <HowTo steps={STEPS} storageKey="nvs:howto:curva-abc" onTour={tour.start} />
        {error && <p className="banner banner-error" role="alert">{error}</p>}

        <div className="abc-metric">
          <div className="seg" role="radiogroup" aria-label="Classificar por">
            {(['revenue', 'units'] as const).map((m) => (
              <button key={m} type="button" role="radio" aria-checked={metric === m} onClick={() => setMetric(m)}>{METRIC_LABEL[m]}</button>
            ))}
          </div>
          <Hint label="faturamento ou unidades">
            Faturamento = preço × quantidade das vendas pagas, antes de tarifas e frete. Unidades = quantas peças saíram. Canceladas e devolvidas ficam de fora nas duas.
          </Hint>
        </div>

        {data && summary && (
          <>
            <section className="abc-classes" aria-label="Resumo por classe">
              {ABC_CLASSES.map((c) => {
                const s = summary[c];
                return (
                  <button key={c} type="button" className="abc-class" data-class={c} aria-pressed={cls === c} onClick={() => setCls(cls === c ? null : c)}>
                    <span className="abc-badge" data-class={c}>{c}</span>
                    <span className="abc-class-name">
                      {CLASS_TEXT[c].name} <Hint label={`classe ${c}`}>{CLASS_TEXT[c].hint}</Hint>
                    </span>
                    <b>{int(s.listings)} {s.listings === 1 ? 'anúncio' : 'anúncios'}</b>
                    <small>{total ? pct(s.listings / total, 0) : '0%'} dos anúncios</small>
                    <span className="abc-class-value"><b>{fmt(s.value)}</b> · {pct(s.share, 1)} {what}</span>
                  </button>
                );
              })}
            </section>

            {total > 0 && (
              <section className="scard abc-pareto" aria-label="Anúncios × vendas">
                <div className="abc-bar-row">
                  <span>Anúncios</span>
                  <div className="abc-bar">{ABC_CLASSES.map((c) => <i key={c} data-class={c} style={{ width: `${(summary[c].listings / total) * 100}%` }} title={`${c}: ${summary[c].listings}`} />)}</div>
                </div>
                <div className="abc-bar-row">
                  <span>{metric === 'revenue' ? 'Faturamento' : 'Unidades'}</span>
                  <div className="abc-bar">{ABC_CLASSES.map((c) => <i key={c} data-class={c} style={{ width: `${summary[c].share * 100}%` }} title={`${c}: ${pct(summary[c].share, 1)}`} />)}</div>
                </div>
                <p className="scard-note">
                  {summary.A.listings > 0 && `${int(summary.A.listings)} de ${int(total)} anúncios (${pct(summary.A.listings / total, 0)}) fazem ${pct(summary.A.share, 0)} ${what}. `}
                  Total do período: <b>{money(data.totals.revenue)}</b> em <b>{int(data.totals.units)}</b> unidades.
                </p>
              </section>
            )}

            <div className="skus-toolbar abc-toolbar">
              <div className="seg" role="radiogroup" aria-label="Classe">
                <button type="button" role="radio" aria-checked={cls === null} onClick={() => setCls(null)}>Todas <span>{int(total)}</span></button>
                {ABC_CLASSES.map((c) => (
                  <button key={c} type="button" role="radio" aria-checked={cls === c} onClick={() => setCls(c)}>{c} <span>{int(summary[c].listings)}</span></button>
                ))}
              </div>
              <label className="search">
                <span className="sr-only">Buscar anúncio</span>
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                <input placeholder="Buscar por título ou MLB" value={q} onChange={(e) => setQ(e.target.value)} />
              </label>
            </div>

            {total === 0 ? (
              <p className="abc-empty">Nenhuma venda paga nos últimos {ABC_PERIOD_DAYS[period]} dias.</p>
            ) : shown.length === 0 ? (
              <p className="abc-empty">Nenhum anúncio encontrado com esse filtro.</p>
            ) : (
              <>
                <div className="abc-cols" aria-hidden="true">
                  <span>#</span><span>Anúncio</span><span>Faturamento</span><span>Unidades</span>
                  <span>% do total <Hint label="% do total">Quanto este anúncio representa sozinho do total do período.</Hint></span>
                  <span>% acumulado <Hint label="% acumulado">Soma deste anúncio com todos os que estão acima dele na fila. É esse número que define a classe: até 80% é A, até 95% é B.</Hint></span>
                  <span>Classe</span>
                </div>
                <ol className="abc-list">
                  {shown.slice(0, limit).map((i) => {
                    const p = i[by];
                    return (
                      <li key={i.listingId} className="abc-row" data-class={p.class}>
                        <span className="abc-rank">{p.rank}º</span>
                        <div className="abc-item">
                          <ProductThumb src={i.pictureUrl} alt={i.title} />
                          <div>
                            <strong title={i.title}>{i.title}</strong>
                            {i.permalink ? <a href={i.permalink} target="_blank" rel="noreferrer">{i.listingId}</a> : <span>{i.listingId}</span>}
                          </div>
                        </div>
                        <span className="abc-num" data-on={metric === 'revenue' || undefined}><small>Faturamento</small><b>{money(i.revenue)}</b></span>
                        <span className="abc-num" data-on={metric === 'units' || undefined}><small>Unidades</small><b>{int(i.units)}</b></span>
                        <span className="abc-num"><small>% do total</small><b>{share(p.share)}</b></span>
                        <span className="abc-num"><small>% acumulado</small><b>{pct(p.cumulative, 1)}</b></span>
                        <span className="abc-badge" data-class={p.class} aria-label={`Classe ${p.class}`}>{p.class}</span>
                      </li>
                    );
                  })}
                </ol>
                {shown.length > limit && (
                  <button type="button" className="act abc-more" onClick={() => setLimit(limit + PAGE)}>
                    Mostrar mais ({int(shown.length - limit)} restantes)
                  </button>
                )}
              </>
            )}
          </>
        )}
      </div>
      {tour.element}
    </AppShell>
  );
}
