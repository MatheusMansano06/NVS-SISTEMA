import { useEffect, useRef, useState } from 'react';
import {
  computePricingStudy,
  marginTone,
  priceForStudyMargin,
  type PricingStudyDto,
  type SavePricingStudyInput,
} from '@nvs/shared';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { useAuth } from '../auth/AuthContext';
import { skusApi } from '../skus/skus-api';
import { parse, toInput } from './num';
import { studiesApi } from './pricing-api';

interface Form {
  title: string;
  link: string;
  supplier: string;
  notes: string;
  feePct: string;
  taxPct: string;
  packaging: string;
  cost: string;
  price: string;
  height: string;
  width: string;
  length: string;
  weightKg: string;
  target: string;
}

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const blank = (taxPct: string): Form => ({
  title: '', link: '', supplier: '', notes: '', feePct: '', taxPct, packaging: '0,50',
  cost: '', price: '', height: '', width: '', length: '', weightKg: '', target: '15',
});

const fromDto = (s: PricingStudyDto): Form => ({
  title: s.title,
  link: s.link ?? '',
  supplier: s.supplier ?? '',
  notes: s.notes ?? '',
  feePct: toInput(s.feePct).replace(/,00$/, ''),
  taxPct: toInput(s.taxPct).replace(/,00$/, ''),
  packaging: toInput(s.packaging),
  cost: toInput(s.cost),
  price: toInput(s.price),
  height: toInput(s.height).replace(/,00$/, ''),
  width: toInput(s.width).replace(/,00$/, ''),
  length: toInput(s.length).replace(/,00$/, ''),
  weightKg: toInput(s.weightKg, 3),
  target: s.targetPct === null ? '' : toInput(s.targetPct).replace(/,00$/, ''),
});

const text = (s: string) => s.trim() || null;
const toPayload = (f: Form): SavePricingStudyInput => ({
  title: f.title.trim(),
  link: text(f.link),
  supplier: text(f.supplier),
  notes: text(f.notes),
  feePct: parse(f.feePct) ?? 0,
  taxPct: parse(f.taxPct) ?? 0,
  packaging: parse(f.packaging) ?? 0,
  cost: parse(f.cost),
  price: parse(f.price),
  height: parse(f.height),
  width: parse(f.width),
  length: parse(f.length),
  weightKg: parse(f.weightKg),
  targetPct: parse(f.target),
});

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim());

/** Precificador › Viabilidade: a planilha de viabilidade da mentoria, uma ficha por produto, salva automaticamente. */
export function StudiesTab() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const [items, setItems] = useState<PricingStudyDto[] | null>(null);
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [companyTax, setCompanyTax] = useState('');
  const [form, setForm] = useState<Form>(() => blank(''));
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState('');
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    studiesApi.list().then(setItems).catch(() => setError('Não foi possível carregar suas pesquisas.'));
    skusApi
      .taxRate()
      .then((t) => {
        const v = String(t.ratePct ?? 0).replace('.', ',');
        setCompanyTax(v);
        setForm((f) => (f.taxPct ? f : { ...f, taxPct: v }));
      })
      .catch(() => undefined);
  }, []);

  const input = toPayload(form);
  const result = computePricingStudy(input);
  const tone = marginTone(result.marginPct);
  const below79 = (input.price ?? 0) > 0 && (input.price ?? 0) < 79;

  function edit(patch: Partial<Form>) {
    setForm((f) => ({ ...f, ...patch }));
    if (selected && canManage) {
      setSave('dirty');
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => void persist(selected), 800);
    }
  }

  // autosave lê o formulário mais recente
  const formRef = useRef(form);
  formRef.current = form;

  async function persist(id: string) {
    const body = toPayload(formRef.current);
    if (!body.title) {
      setSave('error');
      setError('Dê um nome ao produto para salvar.');
      return;
    }
    setSave('saving');
    try {
      const saved = await studiesApi.update(id, body);
      setItems((prev) => [saved, ...(prev ?? []).filter((s) => s.id !== id)]);
      setSave('saved');
      setError('');
    } catch (err) {
      setSave('error');
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  async function create(body = toPayload(form)) {
    if (!body.title) {
      setError('Dê um nome ao produto para salvar.');
      return;
    }
    setSave('saving');
    try {
      const saved = await studiesApi.create(body);
      setItems((prev) => [saved, ...(prev ?? [])]);
      setSelected(saved.id);
      setForm(fromDto(saved));
      setSave('saved');
      setError('');
    } catch (err) {
      setSave('error');
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  function open(s: PricingStudyDto) {
    window.clearTimeout(timer.current);
    if (selected && save === 'dirty') void persist(selected);
    setSelected(s.id);
    setForm(fromDto(s));
    setSave('idle');
    setError('');
  }

  function startNew() {
    window.clearTimeout(timer.current);
    if (selected && save === 'dirty') void persist(selected);
    setSelected(null);
    setForm(blank(companyTax));
    setSave('idle');
    setError('');
  }

  async function remove() {
    if (!selected || !window.confirm(`Excluir a pesquisa “${form.title}”?`)) return;
    window.clearTimeout(timer.current);
    try {
      await studiesApi.remove(selected);
      setItems((prev) => prev?.filter((s) => s.id !== selected) ?? null);
      startNew();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir.');
    }
  }

  function applyTarget() {
    const t = parse(form.target);
    if (t === null || input.cost === null) {
      setError('Preencha o custo e a margem desejada.');
      return;
    }
    const p = priceForStudyMargin(input, t);
    if (p === null) setError('Essa margem não fecha: comissão + imposto + margem passam de 100% do preço.');
    else {
      setError('');
      edit({ price: toInput(p) });
    }
  }

  const term = q.trim().toLowerCase();
  const shown = (items ?? []).filter((s) => !term || [s.title, s.supplier ?? ''].some((v) => v.toLowerCase().includes(term)));

  const field = (k: keyof Form, label: string, opts: { prefix?: string; suffix?: string; placeholder?: string; decimal?: boolean } = {}) => (
    <label className="sku-input">
      <small>{label}</small>
      <span className="sku-field">
        {opts.prefix && <i>{opts.prefix}</i>}
        <input
          inputMode={opts.decimal ? 'decimal' : undefined}
          value={form[k]}
          placeholder={opts.placeholder}
          onChange={(e) => edit({ [k]: e.target.value })}
        />
        {opts.suffix && <i>{opts.suffix}</i>}
      </span>
    </label>
  );

  return (
    <div className="pstudy">
      <aside className="pstudy-list">
        {canManage && (
          <button type="button" className="btn btn-primary" onClick={startNew}>+ Nova pesquisa</button>
        )}
        <label className="search">
          <span className="sr-only">Buscar pesquisa</span>
          <input placeholder="Buscar produto ou fornecedor" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {items && !items.length && <p className="pstudy-empty">Nenhuma pesquisa ainda. Preencha a ficha ao lado e salve para montar sua lista.</p>}
        <ul>
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" aria-current={s.id === selected || undefined} onClick={() => open(s)}>
                <strong>{s.title}</strong>
                <small>{[s.supplier, s.price === null ? null : money(s.price)].filter(Boolean).join(' · ') || '—'}</small>
                <b data-tone={marginTone(s.marginPct)}>{s.marginPct === null ? '—' : pct(s.marginPct, 1)}</b>
              </button>
            </li>
          ))}
        </ul>
      </aside>

      <div className="pstudy-main">
        <header className="pstudy-head">
          <div>
            <small>{selected ? 'Pesquisa salva' : 'Nova pesquisa'}</small>
            <h2>{form.title.trim() || 'Produto sem nome'}</h2>
          </div>
          <span className="pstudy-actions">
            {selected && (
              <span className="pstudy-save" data-state={save}>
                {save === 'saving' ? 'Salvando…' : save === 'dirty' ? 'Alterações pendentes' : save === 'error' ? 'Não salvo' : 'Salvo'}
              </span>
            )}
            {canManage && selected && (
              <>
                <button type="button" className="act" onClick={() => void create({ ...toPayload(form), title: `${form.title.trim()} (cópia)` })}>Duplicar</button>
                <button type="button" className="act link-danger" onClick={() => void remove()}>Excluir</button>
              </>
            )}
            {canManage && !selected && (
              <button type="button" className="btn btn-primary" disabled={save === 'saving'} onClick={() => void create()}>
                {save === 'saving' ? 'Salvando…' : 'Salvar pesquisa'}
              </button>
            )}
          </span>
        </header>

        {error && <p className="banner banner-error" role="alert">{error}</p>}

        <div className="pstudy-grid">
          <div className="pstudy-form">
            <section className="scard">
              <h3>1. Produto</h3>
              <div className="pstudy-row">
                {field('title', 'Nome do produto', { placeholder: 'Ex.: Mouse gamer RGB' })}
                {field('supplier', 'Fornecedor', { placeholder: 'Ex.: Distribuidora X' })}
              </div>
              <label className="sku-input">
                <small>
                  Link do anúncio de referência
                  {isUrl(form.link) && <a className="link pstudy-open" href={form.link.trim()} target="_blank" rel="noreferrer">abrir</a>}
                </small>
                <span className="sku-field"><input value={form.link} placeholder="https://www.mercadolivre.com.br/…" onChange={(e) => edit({ link: e.target.value })} /></span>
              </label>
            </section>

            <section className="scard">
              <h3>2. Números</h3>
              <div className="pstudy-row pstudy-row-3">
                {field('cost', 'Custo do produto', { prefix: 'R$', placeholder: '0,00', decimal: true })}
                {field('price', 'Valor de venda', { prefix: 'R$', placeholder: '0,00', decimal: true })}
                {field('feePct', 'Comissão da categoria', { suffix: '%', placeholder: 'ex.: 11,5', decimal: true })}
                {field('taxPct', 'Imposto', { suffix: '%', decimal: true })}
                {field('packaging', 'Embalagem', { prefix: 'R$', decimal: true })}
              </div>
              <p className="lprice-note">A comissão aparece no anúncio do ML (Clássico ou Premium) para a categoria do produto.</p>
            </section>

            <section className="scard">
              <h3>3. Medidas do produto embalado</h3>
              <div className="ledit-dims">
                {field('height', 'Altura', { suffix: 'cm', decimal: true })}
                {field('width', 'Largura', { suffix: 'cm', decimal: true })}
                {field('length', 'Comprimento', { suffix: 'cm', decimal: true })}
                {field('weightKg', 'Peso', { suffix: 'kg', placeholder: '0,350', decimal: true })}
              </div>
              <p className="lprice-note">
                {result.billedKg === null
                  ? 'Peso em kg (350 g = 0,350). O ML cobra pelo maior entre o peso real e o cubado (A × L × C ÷ 6000).'
                  : `Peso cobrado: ${result.billedKg.toLocaleString('pt-BR', { maximumFractionDigits: 3 })} kg (${result.billedBy === 'cubic' ? 'cubado — a caixa pesa menos do que ocupa' : 'real'}) · faixa ${result.weightBand}.`}
              </p>
            </section>

            <section className="scard">
              <h3>Anotações</h3>
              <label className="sku-input">
                <small className="sr-only">Anotações</small>
                <textarea rows={3} value={form.notes} placeholder="Concorrentes, volume de vendas, ideias de kit…" onChange={(e) => edit({ notes: e.target.value })} />
              </label>
            </section>
          </div>

          <section className="pcol pstudy-result">
            <header><h2>Resultado</h2><small>{below79 ? 'abaixo de R$ 79: o comprador paga o frete e o ML cobra um custo fixo' : (input.price ?? 0) >= 79 ? 'a partir de R$ 79: frete grátis, pago por você' : 'informe o valor de venda'}</small></header>
            <ul className="lprice-break">
              <li><span>Valor de venda</span><b>{input.price ? money(input.price) : '—'}</b></li>
              <li><span>Custo</span><b>{input.cost === null ? '—' : `− ${money(result.cost)}`}</b></li>
              <li><span>Comissão ({input.feePct.toLocaleString('pt-BR')}%)</span><b>− {money(result.commission)}</b></li>
              {below79 ? (
                <li><span>Custo fixo ML</span><b>{result.billedKg === null ? 'informe o peso' : `− ${money(result.fixedFee)}`}</b></li>
              ) : (
                <li><span>Frete grátis</span><b>{result.billedKg === null && (input.price ?? 0) >= 79 ? 'informe o peso' : `− ${money(result.freight)}`}</b></li>
              )}
              <li><span>Imposto ({input.taxPct.toLocaleString('pt-BR')}%)</span><b>− {money(result.tax)}</b></li>
              <li><span>Embalagem</span><b>− {money(result.packaging)}</b></li>
            </ul>
            <div className="pmc" data-tone={tone}>
              <small>Margem de contribuição</small>
              <b>{result.margin === null ? '—' : money(result.margin)}</b>
              <span>{result.marginPct === null ? (input.cost === null ? 'informe o custo' : 'informe o valor de venda') : pct(result.marginPct, 2)}</span>
            </div>
            <div className="ptarget">
              {field('target', 'Margem desejada', { suffix: '%', decimal: true })}
              <button type="button" className="act act-strong" onClick={applyTarget}>Achar preço</button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
