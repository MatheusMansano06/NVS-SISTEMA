import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PROMOTION_TYPE_LABEL,
  marginTone,
  unitMargin,
  type PromotionCandidateDto,
  type PromotionDto,
  type PromotionsDto,
} from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Icon } from '../../shared/ui/Icon';
import { useAuth } from '../auth/AuthContext';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { HowTo, ListingsNav } from './ListingsNav';
import { listingsApi } from './listings-api';
import '../skus/skus.css';
import './listings.css';

const STEPS = [
  { title: 'Escolha a campanha', text: 'À esquerda ficam as promoções abertas da sua conta no Mercado Livre (em andamento ou agendadas).' },
  { title: 'Veja quem está de fora', text: 'Aparecem só os anúncios que podem entrar e ainda não estão nela, com a margem que sobra no preço da oferta.' },
  { title: 'Defina o preço e inscreva', text: 'Quando a campanha pede preço, ajuste dentro do mínimo/máximo do ML. Confirme e o anúncio entra na promoção.' },
];

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' }) : '—');
const toInput = (n: number | null) => (n === null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const parse = (s: string): number | null => {
  const t = s.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
};

type SortKey = 'margin' | 'discount' | 'title';

/** Central de Promoção: inscreve anúncios nas campanhas do ML vendo a margem antes de confirmar. */
export function PromotionsPage() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [promos, setPromos] = useState<PromotionsDto | null>(null);
  const [promosError, setPromosError] = useState('');
  const [selected, setSelected] = useState<PromotionDto | null>(null);
  const [cands, setCands] = useState<PromotionCandidateDto[] | null>(null);
  const [candsError, setCandsError] = useState('');
  const [loadingCands, setLoadingCands] = useState(false);
  const [q, setQ] = useState('');
  const [sort, setSort] = useState<SortKey>('margin');
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  const loadPromos = useCallback(async (refresh = false) => {
    setPromosError('');
    try {
      const r = await listingsApi.promotions(refresh);
      setPromos(r);
      setSelected((cur) => (cur && r.items.some((p) => p.id === cur.id) ? cur : (r.items[0] ?? null)));
    } catch (err) {
      setPromosError(err instanceof ApiError ? err.message : 'Não foi possível carregar as promoções.');
    }
  }, []);

  useEffect(() => void loadPromos(), [loadPromos]);

  const loadCands = useCallback(async (p: PromotionDto, refresh = false) => {
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoadingCands(true);
    setCandsError('');
    try {
      const r = await listingsApi.candidates(p.connectionId, p.id, p.type, refresh, c.signal);
      setCands(r.items);
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setCands([]);
      setCandsError(err instanceof ApiError ? err.message : 'Não foi possível carregar os anúncios elegíveis.');
    } finally {
      if (ctrl.current === c) setLoadingCands(false);
    }
  }, []);

  useEffect(() => {
    setCands(null);
    if (selected) void loadCands(selected);
  }, [selected, loadCands]);

  const notify = useCallback((kind: 'ok' | 'error', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), 5000);
  }, []);

  const visible = useMemo(() => {
    if (!cands || !selected) return [];
    const term = q.trim().toLowerCase();
    const list = term
      ? cands.filter((c) => [c.title, c.sku ?? '', c.id].some((v) => v.toLowerCase().includes(term)))
      : [...cands];
    const offerOf = (c: PromotionCandidateDto) => c.suggestedPrice ?? c.price ?? c.originalPrice ?? 0;
    const marginOf = (c: PromotionCandidateDto) => {
      const p = offerOf(c);
      return unitMargin({ price: p, fee: c.feeRate === null ? null : c.feeRate * p, freight: c.freight, cost: c.cost, taxPct: c.taxPct, source: null }).pct;
    };
    if (sort === 'title') list.sort((a, b) => a.title.localeCompare(b.title));
    if (sort === 'discount') list.sort((a, b) => offerOf(a) / (a.originalPrice || 1) - offerOf(b) / (b.originalPrice || 1));
    if (sort === 'margin') list.sort((a, b) => (marginOf(b) ?? -9) - (marginOf(a) ?? -9));
    return list;
  }, [cands, selected, q, sort]);

  return (
    <AppShell>
      <div className="skus listings">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Central de Promoção</h1>
          </div>
          <button type="button" className="act" onClick={() => void loadPromos(true)}>
            <Icon name="refresh" size={14} /> Atualizar campanhas
          </button>
        </header>
        <ListingsNav />
        <HowTo steps={STEPS} storageKey="nvs:howto:promocoes" />

        {msg && <p className={`banner banner-${msg.kind}`} role="status">{msg.text}</p>}
        {promosError && <p className="banner banner-error" role="alert">{promosError}</p>}
        {promos && !promos.connected && (
          <p className="banner banner-error">Conecte uma conta do Mercado Livre para ver as campanhas.</p>
        )}

        <div className="promo-layout">
          <aside className="promo-list" aria-label="Campanhas">
            <h2>Campanhas abertas {promos && <span>{promos.items.length}</span>}</h2>
            {!promos && !promosError && <div className="promo-skel" aria-hidden="true" />}
            {promos && promos.connected && promos.items.length === 0 && (
              <p className="promo-empty">Nenhuma campanha aberta na sua conta agora. Elas aparecem aqui quando o ML abrir novas.</p>
            )}
            <ul>
              {promos?.items.map((p) => (
                <li key={`${p.connectionId}:${p.id}`}>
                  <button
                    type="button"
                    className="promo-item"
                    aria-pressed={selected?.id === p.id && selected.connectionId === p.connectionId}
                    onClick={() => setSelected(p)}
                  >
                    <span className="promo-item-top">
                      <span className={`tag ${p.status === 'started' ? 'tag-active' : 'tag-type'}`}>
                        {p.status === 'started' ? 'Em andamento' : 'Agendada'}
                      </span>
                      <small>{date(p.startDate)} → {date(p.finishDate)}</small>
                    </span>
                    <strong>{p.name}</strong>
                    <small>
                      {PROMOTION_TYPE_LABEL[p.type] ?? p.type} · {p.requiresPrice ? 'você define o preço' : 'aceitar condições do ML'}
                    </small>
                    {promos.items.some((x) => x.account !== p.account) && <small className="promo-acc">{p.account}</small>}
                  </button>
                </li>
              ))}
            </ul>
          </aside>

          <section className="promo-main" aria-label="Anúncios elegíveis">
            {selected ? (
              <>
                <div className="promo-head">
                  <div>
                    <h2>{selected.name}</h2>
                    <p>
                      {PROMOTION_TYPE_LABEL[selected.type] ?? selected.type}
                      {cands ? ` · ${cands.length} ${cands.length === 1 ? 'anúncio fora da campanha' : 'anúncios fora da campanha'}` : ''}
                    </p>
                  </div>
                  <button type="button" className="act" disabled={loadingCands} onClick={() => void loadCands(selected, true)}>
                    <Icon name="refresh" size={14} /> Atualizar
                  </button>
                </div>
                <div className="skus-toolbar">
                  <label className="search">
                    <span className="sr-only">Buscar</span>
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
                    <input placeholder="Buscar por título, SKU ou MLB" value={q} onChange={(e) => setQ(e.target.value)} />
                  </label>
                  <div className="seg" role="radiogroup" aria-label="Ordenar">
                    {([['margin', 'Maior margem'], ['discount', 'Maior desconto'], ['title', 'A–Z']] as const).map(([id, label]) => (
                      <button key={id} type="button" role="radio" aria-checked={sort === id} onClick={() => setSort(id)}>{label}</button>
                    ))}
                  </div>
                </div>
                {candsError && <p className="banner banner-error" role="alert">{candsError}</p>}
                {cands && cands.length === 0 && !candsError && (
                  <div className="skus-empty">
                    <strong>Nenhum anúncio de fora 🎉</strong>
                    <p>Todos os seus anúncios elegíveis já estão nesta campanha.</p>
                  </div>
                )}
                <div className="lgrid promo-grid" aria-busy={loadingCands}>
                  {visible.map((c) => (
                    <CandidateCard
                      key={c.id}
                      c={c}
                      promo={selected}
                      canManage={canManage}
                      onMsg={notify}
                      onEnrolled={() => setCands((prev) => prev?.filter((x) => x.id !== c.id) ?? prev)}
                    />
                  ))}
                  {loadingCands && !cands && Array.from({ length: 3 }, (_, i) => <div key={i} className="lcard lcard-skeleton" aria-hidden="true" />)}
                </div>
              </>
            ) : (
              promos?.items.length ? null : <div className="promo-placeholder">Escolha uma campanha para ver os anúncios elegíveis.</div>
            )}
          </section>
        </div>
      </div>
    </AppShell>
  );
}

function CandidateCard({
  c,
  promo,
  canManage,
  onMsg,
  onEnrolled,
}: {
  c: PromotionCandidateDto;
  promo: PromotionDto;
  canManage: boolean;
  onMsg: (k: 'ok' | 'error', t: string) => void;
  onEnrolled: () => void;
}) {
  const initial = c.suggestedPrice ?? c.price ?? c.originalPrice;
  const [value, setValue] = useState(toInput(initial));
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);

  const offer = promo.requiresPrice ? parse(value) : (c.price ?? c.suggestedPrice ?? c.originalPrice);
  const outOfRange =
    promo.requiresPrice && offer !== null && ((c.minPrice !== null && offer < c.minPrice - 0.001) || (c.maxPrice !== null && offer > c.maxPrice + 0.001));
  const discount = offer && c.originalPrice ? 1 - offer / c.originalPrice : null;
  const m = unitMargin({
    price: offer,
    fee: c.feeRate === null || offer === null ? null : Math.round(c.feeRate * offer * 100) / 100,
    freight: c.freight,
    cost: c.cost,
    taxPct: c.taxPct,
    source: null,
  });
  const tone = marginTone(m.pct);

  async function enroll() {
    if (promo.requiresPrice && (!offer || offer <= 0 || outOfRange)) return;
    setSaving(true);
    try {
      await listingsApi.enroll(promo.connectionId, promo.id, c.id, {
        promotionType: promo.type,
        ...(promo.requiresPrice && offer ? { dealPrice: offer } : {}),
      });
      onMsg('ok', `${c.sku ?? c.id} inscrito em “${promo.name}”${promo.requiresPrice && offer ? ` por ${money(offer)}` : ''}.`);
      onEnrolled();
    } catch (err) {
      onMsg('error', err instanceof ApiError ? err.message : 'Não foi possível inscrever.');
      setConfirming(false);
    } finally {
      setSaving(false);
    }
  }

  return (
    <article className="lcard pcard">
      <div className="pcard-top">
        <ProductThumb src={c.pictureUrl} alt={c.title} />
        <div className="lcard-head">
          <strong className="lcard-sku">{c.sku ?? c.id}</strong>
          <h3 title={c.title}>{c.title}</h3>
          <p className="lcard-meta">
            <a href={c.permalink ?? undefined} target="_blank" rel="noreferrer">{c.id}</a>
            {c.originalPrice !== null && <span>preço atual {money(c.originalPrice)}</span>}
          </p>
        </div>
      </div>

      <div className="pcard-offer">
        {promo.requiresPrice ? (
          <label className="sku-input">
            <small>Preço da oferta</small>
            <span className="sku-field">
              <i>R$</i>
              <input
                inputMode="decimal"
                value={value}
                disabled={!canManage || saving}
                aria-invalid={outOfRange || undefined}
                onChange={(e) => {
                  setValue(e.target.value);
                  setConfirming(false);
                }}
              />
            </span>
            <small className="pcard-range" data-bad={outOfRange || undefined}>
              {c.minPrice !== null && `mín ${money(c.minPrice)}`}
              {c.minPrice !== null && c.maxPrice !== null && ' · '}
              {c.maxPrice !== null && `máx ${money(c.maxPrice)}`}
              {c.suggestedPrice !== null && (
                <button type="button" className="link" onClick={() => setValue(toInput(c.suggestedPrice))}>usar sugerido</button>
              )}
            </small>
          </label>
        ) : (
          <div className="pcard-fixed">
            <small>Preço na campanha</small>
            <b>{offer === null ? '—' : money(offer)}</b>
          </div>
        )}
        <div className="lcard-mc" data-tone={tone}>
          <span>
            <small>Desconto</small>
            <b>{discount === null ? '—' : pct(discount, 0)}</b>
          </span>
          <span title="Margem de contribuição por unidade no preço da oferta">
            <small>Margem</small>
            <b>{m.amount === null ? '—' : `${money(m.amount)}`}</b>
          </span>
        </div>
      </div>

      <p className="pcard-notes">
        {m.pct !== null && <span data-tone={tone}>sobra {pct(m.pct, 1)} do preço</span>}
        {c.cost === null && <span>sem custo cadastrado — margem desconhecida</span>}
        {c.cost !== null && m.amount === null && <span>sem tarifa/frete conhecidos ainda</span>}
        {c.meliPct ? <span className="pcard-meli">ML banca {c.meliPct.toLocaleString('pt-BR')}% do desconto</span> : null}
      </p>

      {canManage && (
        <footer className="lcard-actions">
          {!confirming ? (
            <button
              type="button"
              className="act act-strong"
              disabled={saving || (promo.requiresPrice && (!offer || outOfRange))}
              onClick={() => setConfirming(true)}
            >
              Inscrever na campanha
            </button>
          ) : (
            <>
              <button type="button" className="act act-go" disabled={saving} onClick={() => void enroll()}>
                {saving ? 'Inscrevendo…' : `Confirmar${promo.requiresPrice && offer ? ` por ${money(offer)}` : ''}`}
              </button>
              <button type="button" className="act" disabled={saving} onClick={() => setConfirming(false)}>Cancelar</button>
            </>
          )}
        </footer>
      )}
    </article>
  );
}
