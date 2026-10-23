import { useCallback, useEffect, useState } from 'react';
import { PRODUCT_RADAR_VERDICT_LABELS, type ProductRadarDayDto, type ProductRadarProductDto } from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { ApiError } from '../../shared/http';
import { int } from '../../shared/format';
import { Icon } from '../../shared/ui/Icon';
import { Modal } from '../../shared/ui/Modal';
import { productRadarApi } from './product-radar-api';
import './product-radar.css';

type Product = ProductRadarProductDto;
type Listing = Product['listings'][number];

const TOP = 5;
const perDay = (n: number | null) => (n === null ? '—' : n.toLocaleString('pt-BR', { maximumFractionDigits: 1 }));
const dayLabel = (d: string) => new Date(`${d}T12:00:00`).toLocaleDateString('pt-BR', { weekday: 'short', day: '2-digit', month: '2-digit' });
const title = (s: string) => s.replace(/(^|\s)\S/g, (c) => c.toUpperCase());
/** aprovado = verde; passou num só critério = amarelo; nenhum = cinza */
const tone = (l: Listing) => (l.approved ? 'ok' : l.passSales || l.passReviews ? 'meio' : 'nao');

function Thumb({ src, big }: { src: string | null; big?: boolean }) {
  return (
    <span className={big ? 'pc-thumb big' : 'pc-thumb'}>
      {src ? <img src={src} alt="" loading="lazy" referrerPolicy="no-referrer" /> : <Icon name="box" size={big ? 40 : 22} />}
    </span>
  );
}

function Verdict({ v }: { v: Product['verdict'] }) {
  return <span className="pc-verdict" data-v={v}>{PRODUCT_RADAR_VERDICT_LABELS[v]}</span>;
}

function Dots({ p }: { p: Product }) {
  return (
    <span className="pc-dots" aria-label={`${p.approved} de ${p.analyzed} anúncios aprovados`}>
      {p.listings.map((l, i) => <i key={i} data-tone={tone(l)} />)}
    </span>
  );
}

/** Anel de aprovação: fração de anúncios que passaram nos dois critérios. */
function Ring({ p }: { p: Product }) {
  const r = 34;
  const c = 2 * Math.PI * r;
  const frac = p.analyzed ? p.approved / p.analyzed : 0;
  return (
    <svg className="pc-ring" viewBox="0 0 84 84" aria-hidden="true">
      <circle cx="42" cy="42" r={r} className="track" />
      <circle cx="42" cy="42" r={r} className="fill" strokeDasharray={`${c * frac} ${c}`} />
      <text x="42" y="40">{p.approved}/{p.analyzed}</text>
      <text x="42" y="56" className="small">aprovados</text>
    </svg>
  );
}

export function ProductRadarPage() {
  const [data, setData] = useState<ProductRadarDayDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<Product | null>(null);

  const load = useCallback(async (day?: string) => {
    try {
      setData(await productRadarApi.day(day));
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível carregar o ranking.');
    }
  }, []);
  useEffect(() => void load(), [load]);

  const remove = async (p: Product) => {
    if (!confirm(`Remover o estudo de "${title(p.search)}"?`)) return;
    try {
      await productRadarApi.remove(p.id);
      setOpen(null);
      await load(data?.day ?? undefined);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : 'Não foi possível remover.');
    }
  };

  const products = data?.products ?? [];
  const [champion, ...rest] = products;
  const podium = rest.slice(0, TOP - 1);
  const others = rest.slice(TOP - 1);
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];

  return (
    <AppShell>
      <div className="pc">
        <header className="pc-head">
          <div className="pc-brand">
            <span className="pc-brand-ico"><Icon name="trophy" /></span>
            <div>
              <b>Produto Campeão</b>
              <small>{categories.length ? categories.join(' · ') : 'Ranking do estudo de viabilidade'}</small>
            </div>
          </div>
          <div className="pc-days" role="tablist" aria-label="Dia do estudo">
            {data?.days.map((d) => (
              <button key={d.day} type="button" role="tab" aria-selected={d.day === data.day} className="pc-day" onClick={() => void load(d.day)}>
                {dayLabel(d.day)}
                <small>{d.viable} {d.viable === 1 ? "viável" : "viáveis"} de {d.products}</small>
              </button>
            ))}
          </div>
        </header>

        {error && <p className="pc-banner">{error}</p>}

        {data && !champion && (
          <section className="pc-empty">
            <span className="pc-brand-ico"><Icon name="trophy" /></span>
            <h2>Nenhum estudo ainda</h2>
            <p>O agente de viabilidade roda de segunda a sexta às 7h. Ele estuda os mais vendidos da categoria e grava aqui o ranking com os anúncios analisados.</p>
          </section>
        )}

        {champion && (
          <button type="button" className="pc-hero" onClick={() => setOpen(champion)}>
            <span className="pc-crown"><Icon name="trophy" size={16} /> Campeão do dia</span>
            <Thumb src={champion.thumbnail} big />
            <div className="pc-hero-main">
              <div className="pc-hero-top">
                <Verdict v={champion.verdict} />
                {champion.category && <span className="pc-cat">{champion.category}</span>}
              </div>
              <h2>{title(champion.search)}</h2>
              {champion.sourceTitle && <p className="pc-source">Do ranking: {champion.sourceTitle}</p>}
              <div className="pc-stats">
                <div><b>{perDay(champion.leaderSalesPerDay)}</b><small>vendas/dia do líder</small></div>
                <div><b>{champion.passSales}/{champion.analyzed}</b><small>vendem 1+/dia</small></div>
                <div><b>{champion.passReviews}/{champion.analyzed}</b><small>avaliações quase diárias</small></div>
              </div>
              {champion.note && <p className="pc-note">{champion.note}</p>}
              <span className="pc-open">Ver os {champion.analyzed} anúncios analisados →</span>
            </div>
            <Ring p={champion} />
          </button>
        )}

        {podium.length > 0 && (
          <section className="pc-podium" aria-label="Top 5">
            {podium.map((p, i) => (
              <button key={p.id} type="button" className="pc-card" onClick={() => setOpen(p)} style={{ animationDelay: `${i * 60}ms` }}>
                <span className="pc-pos">#{i + 2}</span>
                <Thumb src={p.thumbnail} />
                <div className="pc-card-main">
                  <b>{title(p.search)}</b>
                  <Verdict v={p.verdict} />
                  <Dots p={p} />
                  <small>{p.approved}/{p.analyzed} aprovados · líder {perDay(p.leaderSalesPerDay)}/dia</small>
                </div>
              </button>
            ))}
          </section>
        )}

        {others.length > 0 && (
          <section className="pc-others">
            <h3>Também estudados</h3>
            {others.map((p, i) => (
              <button key={p.id} type="button" className="pc-row" onClick={() => setOpen(p)}>
                <span className="pc-pos small">#{i + TOP + 1}</span>
                <b>{title(p.search)}</b>
                <Dots p={p} />
                <Verdict v={p.verdict} />
              </button>
            ))}
          </section>
        )}
      </div>

      <Modal open={!!open} onClose={() => setOpen(null)} label="Anúncios analisados" wide>
        {open && <Detail p={open} onRemove={() => void remove(open)} />}
      </Modal>
    </AppShell>
  );
}

function Detail({ p, onRemove }: { p: Product; onRemove: () => void }) {
  return (
    <div className="pc-detail">
      <header className="pc-detail-head">
        <Thumb src={p.thumbnail} />
        <div>
          <h2>{title(p.search)}</h2>
          <p><Verdict v={p.verdict} /> {p.approved} de {p.analyzed} anúncios aprovados · {p.mode === 'diario' ? 'radar diário' : 'estudo avulso'}{p.category ? ` · ${p.category}` : ''}</p>
        </div>
      </header>
      <p className="pc-rule">
        <Icon name="info" size={16} />
        <span>
          Um anúncio é <b>aprovado</b> quando vende 1 ou mais por dia (vendas estimadas ÷ dias de vida) <b>e</b> tem avaliações em pelo
          menos 5 dos últimos 7 dias (ou as 15 mais recentes todas na semana). Viável = 5 ou mais aprovados; arriscado = 3 ou 4.
        </span>
      </p>
      {p.note && <p className="pc-note">{p.note}</p>}
      <div className="pc-table-wrap">
        <table className="pc-table">
          <thead>
            <tr>
              <th>Anúncio</th><th>Dias de vida</th><th>Vendas est.</th><th>Vendas/dia</th><th>Ritmo/mês</th><th>Avaliações 7d</th><th>Vende 1+/dia</th><th>Avaliações</th>
            </tr>
          </thead>
          <tbody>
            {p.listings.map((l, i) => (
              <tr key={i} data-tone={tone(l)}>
                <td>
                  <div className="pc-ad">
                    <Thumb src={l.thumbnail} />
                    <div>
                      {l.link ? <a href={l.link} target="_blank" rel="noreferrer">{l.title}</a> : l.title}
                      <small>{l.kind === 'catalogo' ? 'Catálogo' : 'Anúncio'}{l.note ? ` · ${l.note}` : ''}</small>
                    </div>
                  </div>
                </td>
                <td>{l.ageDays === null ? '—' : int(l.ageDays)}</td>
                <td>{l.estSales === null ? '—' : int(l.estSales)}</td>
                <td><b>{perDay(l.salesPerDay)}</b></td>
                <td>{l.monthlyPace === null ? '—' : int(l.monthlyPace)}</td>
                <td>{l.reviewDays7d === null ? '—' : `${l.reviewDays7d} dias · ${l.reviews7d ?? 0} aval.`}</td>
                <td><span className="pc-check" data-ok={l.passSales}>{l.passSales ? 'Sim' : 'Não'}</span></td>
                <td><span className="pc-check" data-ok={l.passReviews}>{l.passReviews ? 'Sim' : 'Não'}</span></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <footer className="pc-detail-foot">
        <small>Estudado em {new Date(p.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>
        <button type="button" className="pc-remove" onClick={onRemove}>Remover estudo</button>
      </footer>
    </div>
  );
}
