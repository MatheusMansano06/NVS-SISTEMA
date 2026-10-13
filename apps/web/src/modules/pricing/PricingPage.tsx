import { useCallback, useEffect, useRef, useState } from 'react';
import {
  marginTone,
  priceForMargin,
  unitMargin,
  type CategoryInfoDto,
  type ListingDto,
  type PricingSimulationDto,
} from '@nvs/shared';
import { AppShell } from '../../app/AppShell';
import { navigate } from '../../app/router';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { useAuth } from '../auth/AuthContext';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { HowTo } from '../listings/ListingsNav';
import { listingsApi } from '../listings/listings-api';
import { skusApi } from '../skus/skus-api';
import { pricingApi } from './pricing-api';
import { CategoryBrowser, feeChips } from './CategoryBrowser';
import '../skus/skus.css';
import '../listings/listings.css';
import '../sales/sales.css';
import './pricing.css';

type TypeId = 'gold_special' | 'gold_pro';
interface Option { type: TypeId; label: string; feePct: number | null; fixedFee: number; fee: number }

const STEPS = [
  { title: 'Escolha o produto', text: 'Puxe um anúncio (frete e tarifa vêm do Mercado Livre) ou faça uma simulação livre escolhendo a categoria.' },
  { title: 'Ajuste os números', text: 'Mude preço, custo e imposto e veja a margem no Clássico e no Premium ao mesmo tempo.' },
  { title: 'Decida', text: 'Use “margem desejada” para achar o preço certo. Aplique no anúncio ou salve a simulação para comparar depois.' },
];

/** Sem consulta ao ML: tarifas médias (como no sistema antigo), marcadas como estimadas. */
const FALLBACK: Option[] = [
  { type: 'gold_special', label: 'Clássico', feePct: 12, fixedFee: 0, fee: 0 },
  { type: 'gold_pro', label: 'Premium', feePct: 17, fixedFee: 0, fee: 0 },
];

const toInput = (n: number | null | undefined) => (n == null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const parse = (s: string): number | null => {
  const t = s.replace(/[R$\s%]/g, '').replace(/\./g, '').replace(',', '.');
  const n = Number(t);
  return t && Number.isFinite(n) ? n : null;
};
const readParam = () => new URLSearchParams(window.location.search).get('anuncio') ?? undefined;

/** Precificador: Clássico × Premium lado a lado, preço para margem alvo e simulações salvas. */
export function PricingPage() {
  const [tab, setTab] = useState<'calc' | 'saved'>('calc');
  const [savedCount, setSavedCount] = useState<number | null>(null);
  useEffect(() => {
    pricingApi.simulations().then((s) => setSavedCount(s.length)).catch(() => undefined);
  }, []);
  return (
    <AppShell>
      <div className="skus pricing">
        <header className="skus-head">
          <div>
            <p className="dash-kicker">Mercado Livre</p>
            <h1>Precificador</h1>
          </div>
          <div className="seg" role="tablist" aria-label="Precificador">
            <button type="button" role="tab" aria-checked={tab === 'calc'} onClick={() => setTab('calc')}>Calcular</button>
            <button type="button" role="tab" aria-checked={tab === 'saved'} onClick={() => setTab('saved')}>
              Simulações salvas {savedCount !== null && <span>{savedCount}</span>}
            </button>
          </div>
        </header>
        <HowTo steps={STEPS} storageKey="nvs:howto:precificador" />
        {tab === 'calc' ? <Calculator onSaved={() => setSavedCount((n) => (n ?? 0) + 1)} /> : <Saved onCount={setSavedCount} />}
      </div>
    </AppShell>
  );
}

function Calculator({ onSaved }: { onSaved: () => void }) {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [mode, setMode] = useState<'listing' | 'free'>('listing');
  const [listing, setListing] = useState<ListingDto | null>(null);
  const [category, setCategory] = useState<CategoryInfoDto | null>(null);
  const [freeTitle, setFreeTitle] = useState('');
  const [freeType, setFreeType] = useState<TypeId>('gold_special');
  const [dims, setDims] = useState({ height: '', width: '', length: '', weight: '' });
  const [freightManual, setFreightManual] = useState(false);
  const [freightNote, setFreightNote] = useState('');
  const [price, setPrice] = useState('');
  const [cost, setCost] = useState('');
  const [freight, setFreight] = useState('');
  const [tax, setTax] = useState('');
  const [target, setTarget] = useState('15');
  const [options, setOptions] = useState<Option[]>([]);
  const [freightLocked, setFreightLocked] = useState(false);
  const [currentType, setCurrentType] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [estimated, setEstimated] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  // alíquota da empresa como padrão do imposto
  useEffect(() => {
    skusApi.taxRate().then((t) => setTax((v) => v || String(t.ratePct ?? 0).replace('.', ','))).catch(() => undefined);
  }, []);

  // anúncio vindo do card (?anuncio=MLB…)
  useEffect(() => {
    const id = readParam();
    if (!id) return;
    (async () => {
      for (const status of ['active', 'paused'] as const) {
        const r = await listingsApi.list({ status, q: id, offset: 0, limit: 1 }).catch(() => null);
        const hit = r?.items.find((i) => i.id === id);
        if (hit) return pick(hit);
      }
    })();
  }, []);

  function pick(l: ListingDto) {
    setListing(l);
    setMode('listing');
    setPrice(toInput(l.price));
    setCost(toInput(l.cost));
    setFreight(toInput(l.margin.freight));
    setCurrentType(l.type === 'Premium' ? 'gold_pro' : l.type === 'Clássico' ? 'gold_special' : null);
    const url = new URL(window.location.href);
    url.searchParams.set('anuncio', l.id);
    window.history.replaceState(null, '', url);
  }

  const priceNum = parse(price);
  const costNum = parse(cost);
  const freightNum = parse(freight) ?? 0;
  const taxNum = parse(tax) ?? 0;

  // tarifas reais (debounce) sempre que o preço/produto muda
  const fetchQuote = useCallback(async () => {
    if (!priceNum || priceNum <= 0) return;
    if (mode === 'listing' && !listing) return;
    ctrl.current?.abort();
    const c = new AbortController();
    ctrl.current = c;
    setLoading(true);
    setError('');
    setEstimated(false);
    try {
      if (mode === 'listing' && listing) {
        const r = await listingsApi.pricing(listing.id, priceNum === listing.price ? undefined : priceNum, c.signal, true);
        setOptions(
          r.options.map((o) => ({
            type: o.type,
            label: o.label,
            feePct: o.feePct,
            fee: o.fee,
            fixedFee: o.feePct !== null ? Math.max(0, Math.round((o.fee - (priceNum * o.feePct) / 100) * 100) / 100) : 0,
          })),
        );
        if (r.freight !== null) {
          setFreight(toInput(r.freight));
          setFreightLocked(true);
        }
        setCurrentType(r.type);
      } else {
        const r = await pricingApi.quote(priceNum, category?.id || undefined, c.signal);
        setOptions(r.fees);
        setFreightLocked(false);
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setOptions(FALLBACK);
      setEstimated(true);
      setError(`${err instanceof ApiError ? err.message : 'Não foi possível consultar as tarifas agora.'} Usando tarifa média (Clássico 12%, Premium 17%).`);
    } finally {
      if (ctrl.current === c) setLoading(false);
    }
  }, [priceNum, mode, listing, category]);

  useEffect(() => {
    const t = window.setTimeout(() => void fetchQuote(), 500);
    return () => window.clearTimeout(t);
  }, [fetchQuote]);

  // simulação livre: frete calculado pelo ML a partir das medidas (a menos que a pessoa digite o frete)
  const dimsNum = {
    height: parse(dims.height),
    width: parse(dims.width),
    length: parse(dims.length),
    weight: parse(dims.weight),
  };
  const dimsOk = Object.values(dimsNum).every((v) => v !== null && v > 0);
  const freightCtrl = useRef<AbortController | null>(null);
  useEffect(() => {
    if (mode !== 'free' || freightManual || !priceNum || !dimsOk) return;
    const t = window.setTimeout(async () => {
      freightCtrl.current?.abort();
      const c = new AbortController();
      freightCtrl.current = c;
      try {
        const r = await pricingApi.freight(
          {
            price: priceNum,
            type: freeType,
            height: dimsNum.height!,
            width: dimsNum.width!,
            length: dimsNum.length!,
            weight: Math.round(dimsNum.weight!),
            categoryId: category?.id || undefined,
          },
          c.signal,
        );
        setFreight(toInput(r.freight));
        setFreightLocked(true);
        setFreightNote(r.source === 'none' ? 'abaixo de R$ 79 o comprador paga o frete' : 'calculado pelo ML para essas medidas, com a reputação da sua conta');
      } catch (err) {
        if ((err as Error).name === 'AbortError') return;
        setFreightLocked(false);
        setFreightNote(`${err instanceof ApiError ? err.message : 'Não deu para calcular o frete.'} Informe o frete manualmente.`);
      }
    }, 500);
    return () => window.clearTimeout(t);
  }, [mode, freightManual, priceNum, dims, freeType, category, dimsOk]);

  async function pickCategory(id: string) {
    try {
      const info = await pricingApi.category(id);
      setCategory(info);
      if (info.dims) {
        setDims({
          height: String(info.dims.height),
          width: String(info.dims.width),
          length: String(info.dims.length),
          weight: String(info.dims.weight),
        });
      }
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Não foi possível abrir a categoria.');
    }
  }

  const notify = (kind: 'ok' | 'error', text: string) => {
    setMsg({ kind, text });
    window.setTimeout(() => setMsg((m) => (m?.text === text ? null : m)), 5000);
  };

  // a tarifa acompanha o preço digitado (% + fixo), sem esperar a consulta
  const feeAt = (o: Option, p: number) => (o.feePct !== null ? Math.round((p * o.feePct + o.fixedFee * 100)) / 100 : o.fee);
  const calc = (o: Option) => {
    const p = priceNum ?? 0;
    const fee = Math.max(0, feeAt(o, p) - (listing?.feeBonus ?? 0));
    return { fee, m: unitMargin({ price: p || null, fee, freight: freightNum, cost: costNum, taxPct: taxNum, source: 'live' }) };
  };

  function applyTarget() {
    const t = parse(target);
    const base = options.find((o) => o.type === (mode === 'free' ? freeType : currentType)) ?? options[0];
    if (t === null || !base || base.feePct === null || costNum === null) {
      notify('error', 'Preencha o custo e aguarde as tarifas para calcular.');
      return;
    }
    const p = priceForMargin({ targetPct: t, feePct: base.feePct, fixedFee: base.fixedFee, freight: freightNum, cost: costNum, taxPct: taxNum });
    if (p === null) notify('error', 'Essa margem não fecha: tarifa + imposto + margem passam de 100% do preço.');
    else setPrice(toInput(p));
  }

  async function applyPrice() {
    if (!listing || !priceNum) return;
    setBusy('price');
    try {
      await listingsApi.setPrice(listing.id, priceNum);
      if (costNum !== null && costNum > 0 && costNum !== listing.cost && listing.sku) await skusApi.save(listing.sku, costNum);
      setListing({ ...listing, price: priceNum, cost: costNum });
      notify('ok', `Preço ${money(priceNum)} aplicado no Mercado Livre.`);
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Não foi possível aplicar o preço.');
    } finally {
      setBusy(null);
    }
  }

  async function switchType(type: TypeId) {
    if (!listing) return;
    setBusy(type);
    try {
      await listingsApi.setType(listing.id, type);
      setCurrentType(type);
      notify('ok', `Anúncio agora é ${type === 'gold_pro' ? 'Premium' : 'Clássico'}.`);
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Não foi possível trocar o tipo.');
    } finally {
      setBusy(null);
    }
  }

  async function save(o: Option) {
    if (!priceNum) return;
    setBusy(`save-${o.type}`);
    try {
      await pricingApi.save({
        listingId: listing?.id,
        title: listing?.title ?? (freeTitle.trim() || category?.name || 'Simulação livre'),
        sku: listing?.sku ?? undefined,
        listingType: o.type,
        price: priceNum,
        cost: costNum,
        freight: freightNum,
        taxPct: taxNum,
        fee: calc(o).fee,
      });
      onSaved();
      notify('ok', `Simulação ${o.label} salva.`);
    } catch (err) {
      notify('error', err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="pcalc">
      <div className="seg ledit-seg" role="radiogroup" aria-label="O que precificar">
        <button type="button" role="radio" aria-checked={mode === 'listing'} onClick={() => setMode('listing')}>De um anúncio</button>
        <button type="button" role="radio" aria-checked={mode === 'free'} onClick={() => { setMode('free'); setListing(null); setFreightLocked(false); setCurrentType(null); setOptions([]); }}>Simulação livre</button>
      </div>

      {mode === 'listing' ? (
        listing ? (
          <div className="sfilter-chosen">
            <ProductThumb src={listing.pictureUrl} alt={listing.title} />
            <div>
              <small>{listing.type ?? 'Anúncio'} · preço atual {listing.price === null ? '—' : money(listing.price)}</small>
              <strong>{listing.title}</strong>
              <span>{listing.sku ? `${listing.sku} · ` : ''}{listing.id}</span>
            </div>
            <button type="button" className="act" onClick={() => { setListing(null); setOptions([]); }}>Trocar anúncio</button>
          </div>
        ) : (
          <ListingSearch onPick={pick} />
        )
      ) : (
        !category ? (
          <CategoryBrowser
            onPick={(id) => void pickCategory(id)}
            onSkip={() => setCategory({ id: '', name: 'Sem categoria (tarifa média)', leaf: true, feeClassic: 12, feePremium: 17, path: [], dims: null })}
          />
        ) : (
          <>
            <div className="pcat-chosen">
              <span>
                <small>Categoria</small>
                <strong>{category.path.map((p) => p.name).join(' › ') || category.name}</strong>
                {feeChips(category)}
              </span>
              <button type="button" className="act" onClick={() => { setCategory(null); setOptions([]); }}>Trocar categoria</button>
            </div>
            <div className="pfree">
              <label className="sku-input">
                <small>Nome do produto (opcional, para salvar)</small>
                <span className="sku-field"><input value={freeTitle} onChange={(e) => setFreeTitle(e.target.value)} placeholder="Ex.: Viseira fumê" /></span>
              </label>
              <div>
                <small className="pfree-label">2. Tipo de anúncio</small>
                <div className="seg" role="radiogroup" aria-label="Tipo de anúncio">
                  {(['gold_special', 'gold_pro'] as const).map((t) => (
                    <button key={t} type="button" role="radio" aria-checked={freeType === t} onClick={() => setFreeType(t)}>
                      {t === 'gold_pro' ? 'Premium' : 'Clássico'}{' '}
                      <span>{(t === 'gold_pro' ? category.feePremium : category.feeClassic)?.toLocaleString('pt-BR') ?? '—'}%</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <section className="scard pdims">
              <header className="scard-head">
                <div>
                  <h2>3. Medidas do pacote (para o frete)</h2>
                  <p>{category.dims ? 'Preenchido com o tamanho médio da categoria — ajuste para o seu produto embalado.' : 'Informe as medidas do produto embalado.'}</p>
                </div>
              </header>
              <div className="ledit-dims">
                {([['height', 'Altura', 'cm'], ['width', 'Largura', 'cm'], ['length', 'Comprimento', 'cm'], ['weight', 'Peso', 'g']] as const).map(([k, label, unit]) => (
                  <label key={k} className="sku-input">
                    <small>{label}</small>
                    <span className="sku-field">
                      <input inputMode="decimal" value={dims[k]} onChange={(e) => setDims({ ...dims, [k]: e.target.value })} />
                      <i>{unit}</i>
                    </span>
                  </label>
                ))}
              </div>
            </section>
          </>
        )
      )}

      {msg && <p className={`banner banner-${msg.kind}`} role="status">{msg.text}</p>}

      <section className="scard pinputs">
        <label className="sku-input">
          <small>Valor de venda</small>
          <span className="sku-field"><i>R$</i><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0,00" /></span>
        </label>
        <label className="sku-input">
          <small>
            Frete {freightLocked ? '· vem do ML' : '(pago por você)'}
            {mode === 'free' && (
              <button
                type="button"
                className="link pfreight-toggle"
                onClick={() => {
                  setFreightManual((v) => !v);
                  setFreightLocked(false);
                  setFreightNote('');
                }}
              >
                {freightManual ? 'calcular pelas medidas' : 'digitar'}
              </button>
            )}
          </small>
          <span className="sku-field" data-locked={freightLocked || undefined}>
            <i>R$</i>
            <input inputMode="decimal" value={freight} readOnly={freightLocked} onChange={(e) => setFreight(e.target.value)} placeholder="0,00" />
          </span>
        </label>
        <label className="sku-input">
          <small>Custo do produto</small>
          <span className="sku-field"><i>R$</i><input inputMode="decimal" value={cost} onChange={(e) => setCost(e.target.value)} placeholder="0,00" /></span>
        </label>
        <label className="sku-input">
          <small>Imposto</small>
          <span className="sku-field"><input inputMode="decimal" value={tax} onChange={(e) => setTax(e.target.value)} /><i>%</i></span>
        </label>
        <div className="ptarget">
          <label className="sku-input">
            <small>Margem desejada</small>
            <span className="sku-field"><input inputMode="decimal" value={target} onChange={(e) => setTarget(e.target.value)} /><i>%</i></span>
          </label>
          <button type="button" className="act act-strong" onClick={applyTarget}>Calcular preço</button>
        </div>
      </section>

      {error && <p className={`banner ${estimated ? 'banner-warn' : 'banner-error'}`} role="alert">{error}</p>}
      {mode === 'free' && freightNote && <p className="lprice-note">Frete: {freightNote.replace(/\.+$/, '')}.</p>}

      <div className="pcols" aria-busy={loading}>
        {(mode === 'free' ? options.filter((o) => o.type === freeType) : options).map((o) => {
          const { fee, m } = calc(o);
          const other = mode === 'free' ? options.find((x) => x.type !== o.type) : undefined;
          const otherM = other ? calc(other).m : null;
          const active = currentType === o.type;
          const tone = marginTone(m.pct);
          return (
            <section key={o.type} className="pcol" data-active={active || undefined}>
              <header>
                <h2>{o.label}</h2>
                {active && <span className="tag tag-active">exposição atual</span>}
                <small>{o.type === 'gold_pro' ? 'parcela sem juros, mais exposição' : 'tarifa menor'}</small>
              </header>
              <ul className="lprice-break">
                <li><span>Valor de venda</span><b>{priceNum ? money(priceNum) : '—'}</b></li>
                <li><span>Frete {freightLocked ? '(travado)' : ''}</span><b>− {money(freightNum)}</b></li>
                <li><span>Custo</span><b>{costNum === null ? '—' : `− ${money(costNum)}`}</b></li>
                <li><span>Imposto ({taxNum.toLocaleString('pt-BR')}%)</span><b>− {money(m.tax)}</b></li>
                <li>
                  <span>Tarifa de venda {o.feePct !== null ? `(${o.feePct.toLocaleString('pt-BR')}%)` : ''}{listing?.feeBonus ? ' já com bônus' : ''}</span>
                  <b>− {money(fee)}</b>
                </li>
              </ul>
              <div className="pmc" data-tone={tone}>
                <small>Margem de contribuição</small>
                <b>{m.amount === null ? '—' : money(m.amount)}</b>
                <span>{m.pct === null ? (costNum === null ? 'informe o custo' : '') : pct(m.pct, 2)}</span>
              </div>
              {other && otherM?.amount != null && (
                <p className="lprice-note">
                  No {other.label} seria {money(otherM.amount)} ({pct(otherM.pct ?? 0, 1)}).{' '}
                  <button type="button" className="link" onClick={() => setFreeType(other.type)}>Ver {other.label}</button>
                </p>
              )}
              <footer className="lcard-actions">
                {canManage && listing && !active && (
                  <button type="button" className="act" disabled={busy !== null} onClick={() => void switchType(o.type)}>
                    {busy === o.type ? 'Trocando…' : `Mudar anúncio para ${o.label}`}
                  </button>
                )}
                {canManage && (
                  <button type="button" className="act" disabled={busy !== null || !priceNum} onClick={() => void save(o)}>
                    {busy === `save-${o.type}` ? 'Salvando…' : 'Salvar simulação'}
                  </button>
                )}
              </footer>
            </section>
          );
        })}
        {!options.length && !loading && !error && (
          <p className="promo-placeholder">{mode === 'listing' && !listing ? 'Escolha um anúncio para começar.' : 'Informe o valor de venda para ver as tarifas.'}</p>
        )}
      </div>

      {canManage && listing && priceNum && priceNum !== listing.price && (
        <div className="papply">
          <span>Preço atual {listing.price === null ? '—' : money(listing.price)} → novo <b>{money(priceNum)}</b></span>
          <button type="button" className="btn btn-primary" disabled={busy !== null || listing.catalog} onClick={() => void applyPrice()}>
            {busy === 'price' ? 'Aplicando…' : 'Aplicar preço ao anúncio'}
          </button>
        </div>
      )}
    </div>
  );
}

function ListingSearch({ onPick }: { onPick: (l: ListingDto) => void }) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<ListingDto[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setResults([]);
    const t = window.setTimeout(async () => {
      const [a, p] = await Promise.all([
        listingsApi.list({ status: 'active', q: term, offset: 0, limit: 6 }).catch(() => null),
        listingsApi.list({ status: 'paused', q: term, offset: 0, limit: 4 }).catch(() => null),
      ]);
      setResults([...(a?.items ?? []), ...(p?.items ?? [])]);
    }, 300);
    return () => window.clearTimeout(t);
  }, [q]);
  return (
    <div className="sfilter">
      <label className="search">
        <span className="sr-only">Buscar anúncio</span>
        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
        <input placeholder="Buscar anúncio por título, SKU ou MLB" value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
      </label>
      {results.length > 0 && (
        <ul className="sfilter-results" role="listbox">
          {results.map((r) => (
            <li key={r.id}>
              <button type="button" role="option" aria-selected={false} onClick={() => onPick(r)}>
                <ProductThumb src={r.pictureUrl} alt={r.title} />
                <span><strong>{r.sku ?? r.id} · {r.price === null ? '—' : money(r.price)}</strong><small>{r.title}</small></span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Saved({ onCount }: { onCount: (n: number) => void }) {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [items, setItems] = useState<PricingSimulationDto[] | null>(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  useEffect(() => {
    pricingApi
      .simulations()
      .then((s) => {
        setItems(s);
        onCount(s.length);
      })
      .catch(() => setError('Não foi possível carregar as simulações.'));
  }, [onCount]);

  async function remove(id: string) {
    await pricingApi.remove(id).catch(() => undefined);
    setItems((prev) => {
      const next = prev?.filter((s) => s.id !== id) ?? null;
      onCount(next?.length ?? 0);
      return next;
    });
  }

  const term = q.trim().toLowerCase();
  const shown = (items ?? []).filter((s) => !term || [s.title, s.sku ?? '', s.listingId ?? ''].some((v) => v.toLowerCase().includes(term)));
  return (
    <>
      <label className="search">
        <span className="sr-only">Buscar</span>
        <input placeholder="Buscar por SKU ou nome do produto" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {items && !items.length && (
        <div className="skus-empty"><strong>Nenhuma simulação salva</strong><p>Em “Calcular”, use “Salvar simulação” para guardar e comparar depois.</p></div>
      )}
      <div className="psaved">
        {shown.map((s) => {
          const tone = marginTone(s.marginPct);
          const applied = s.currentPrice !== null && Math.abs(s.currentPrice - s.price) < 0.005;
          return (
            <article key={s.id} className="psim">
              <header>
                <strong>{s.sku ?? (s.listingId ? s.listingId : 'Simulação livre')}</strong>
                <span className="tag tag-type">{s.listingType === 'gold_pro' ? 'Premium' : 'Clássico'}</span>
              </header>
              <p className="psim-title" title={s.title}>{s.title}</p>
              <p className="psim-cost">custo <b>{s.cost === null ? '—' : money(s.cost)}</b> · frete {money(s.freight)} · tarifa {money(s.fee)}</p>
              <div className="lcard-mc" data-tone={tone}>
                <span><small>Vender a</small><b>{money(s.price)}</b></span>
                <span><small>MC</small><b>{s.marginPct === null ? '—' : pct(s.marginPct, 1)}</b></span>
                <span><small>MC R$</small><b>{s.margin === null ? '—' : money(s.margin)}</b></span>
              </div>
              <footer>
                <small>
                  salvo em {new Date(s.createdAt).toLocaleDateString('pt-BR')}
                  {s.listingId && s.currentPrice !== null && (applied ? ' · já aplicado' : ` · hoje ${money(s.currentPrice)}`)}
                </small>
                <span className="psim-actions">
                  {s.listingId && <button type="button" className="link" onClick={() => navigate(`/precificador?anuncio=${s.listingId}`)}>Abrir</button>}
                  {canManage && <button type="button" className="link link-danger" onClick={() => void remove(s.id)}>Excluir</button>}
                </span>
              </footer>
            </article>
          );
        })}
      </div>
    </>
  );
}
