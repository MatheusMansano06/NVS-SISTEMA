import { useEffect, useRef, useState } from 'react';
import {
  computePricingStudy,
  costWithMarkup,
  marginTone,
  priceForStudyMargin,
  type PricingStudyDto,
  type PricingSupplierDto,
  type SavePricingStudyInput,
} from '@nvs/shared';
import { money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { useAuth } from '../auth/AuthContext';
import { skusApi } from '../skus/skus-api';
import { parse, toInput } from './num';
import { CategoryBrowser } from './CategoryBrowser';
import { pricingApi, studiesApi, suppliersApi } from './pricing-api';
import { QuoteImport } from './QuoteImport';

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
  category: Category | null;
  listingType: 'gold_special' | 'gold_pro' | null;
  /** Preço na cotação do fornecedor ('' = custo digitado à mão). */
  supplierCost: string;
  quoteRef: string | null;
  quoteItem: string | null;
}

interface Category { id: string | null; name: string; feeClassic: number | null; feePremium: number | null }

type SaveState = 'idle' | 'dirty' | 'saving' | 'saved' | 'error';

const blank = (taxPct: string, supplier = ''): Form => ({
  title: '', link: '', supplier, notes: '', feePct: '', taxPct, packaging: '0,50',
  cost: '', price: '', height: '', width: '', length: '', weightKg: '', target: '15', category: null, listingType: null,
  supplierCost: '', quoteRef: null, quoteItem: null,
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
  category: s.categoryName ? { id: s.categoryId, name: s.categoryName, feeClassic: s.feeClassic, feePremium: s.feePremium } : null,
  listingType: s.listingType,
  supplierCost: toInput(s.supplierCost),
  quoteRef: s.quoteRef,
  quoteItem: s.quoteItem,
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
  categoryId: f.category?.id ?? null,
  categoryName: f.category?.name ?? null,
  feeClassic: f.category?.feeClassic ?? null,
  feePremium: f.category?.feePremium ?? null,
  listingType: f.category ? f.listingType : null,
  supplierCost: parse(f.supplierCost),
  quoteRef: f.quoteRef,
  quoteItem: f.quoteItem,
});

const same = (a: string | null | undefined, b: string | null | undefined) => (a ?? '').trim().toLowerCase() === (b ?? '').trim().toLowerCase();
const pctText = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Pasta escolhida na lista: todas, as sem fornecedor ou um fornecedor (id). */
type Folder = 'all' | 'none' | string;

const typeFee = (c: Category, t: 'gold_special' | 'gold_pro') => (t === 'gold_pro' ? c.feePremium : c.feeClassic);
const feeText = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

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
  const [browsing, setBrowsing] = useState(false);
  const [suppliers, setSuppliers] = useState<PricingSupplierDto[]>([]);
  const [folder, setFolder] = useState<Folder>('all');
  const [importing, setImporting] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    studiesApi.list().then(setItems).catch(() => setError('Não foi possível carregar suas pesquisas.'));
    loadSuppliers();
    skusApi
      .taxRate()
      .then((t) => {
        const v = String(t.ratePct ?? 0).replace('.', ',');
        setCompanyTax(v);
        setForm((f) => (f.taxPct ? f : { ...f, taxPct: v }));
      })
      .catch(() => undefined);
  }, []);

  function loadSuppliers() {
    suppliersApi.list().then(setSuppliers).catch(() => undefined);
  }

  const current = suppliers.find((x) => x.id === folder) ?? null;
  const formSupplier = suppliers.find((x) => same(x.name, form.supplier)) ?? null;
  const markup = formSupplier?.costMarkupPct ?? 0;

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
      if (saved.supplier && !suppliers.some((x) => same(x.name, saved.supplier))) loadSuppliers();
      setForm((f) => (f.supplierCost && saved.cost !== null ? { ...f, cost: toInput(saved.cost) } : f));
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
      if (saved.supplier && !suppliers.some((x) => same(x.name, saved.supplier))) loadSuppliers();
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
    setForm(blank(companyTax, current?.name ?? ''));
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

  function chooseType(t: 'gold_special' | 'gold_pro', c = form.category) {
    const fee = c && typeFee(c, t);
    if (!c || fee == null) return;
    edit({ category: c, listingType: t, feePct: feeText(fee) });
  }

  async function pickCategory(id: string) {
    try {
      const info = await pricingApi.category(id);
      const c = { id: info.id, name: info.path.map((p) => p.name).join(' › ') || info.name, feeClassic: info.feeClassic, feePremium: info.feePremium };
      setBrowsing(false);
      chooseType(form.listingType ?? 'gold_special', c);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível abrir a categoria.');
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

  async function newSupplier() {
    const name = window.prompt('Nome do fornecedor (vira uma pasta):')?.trim();
    if (!name) return;
    const pct = parse(window.prompt(`Quanto somar ao preço da cotação de ${name}? (IPI/ST/frete de compra, em %)`, '0') ?? '') ?? 0;
    try {
      const sup = await suppliersApi.create({ name, costMarkupPct: pct });
      setSuppliers((prev) => [...prev, sup].sort((a, b) => a.name.localeCompare(b.name, 'pt-BR')));
      setFolder(sup.id);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar o fornecedor.');
    }
  }

  async function editSupplier(sup: PricingSupplierDto, patch: Partial<PricingSupplierDto>) {
    try {
      const saved = await suppliersApi.update(sup.id, { name: patch.name ?? sup.name, costMarkupPct: patch.costMarkupPct ?? sup.costMarkupPct });
      setSuppliers((prev) => prev.map((x) => (x.id === sup.id ? saved : x)));
      // o servidor renomeia as fichas e refaz custo/margem das que vieram de cotação
      const fresh = await studiesApi.list();
      setItems(fresh);
      const open = selected && fresh.find((s) => s.id === selected);
      if (open) setForm(fromDto(open));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar o fornecedor.');
    }
  }

  function renameSupplier(sup: PricingSupplierDto) {
    const name = window.prompt('Novo nome do fornecedor:', sup.name)?.trim();
    if (name && name !== sup.name) void editSupplier(sup, { name });
  }

  function changeMarkup(sup: PricingSupplierDto) {
    const v = window.prompt(`% somado ao preço da cotação de ${sup.name} (IPI/ST/frete de compra):`, pctText(sup.costMarkupPct));
    const pct = v === null ? null : parse(v);
    if (pct !== null && pct !== sup.costMarkupPct) void editSupplier(sup, { costMarkupPct: pct });
  }

  async function removeSupplier(sup: PricingSupplierDto) {
    if (!window.confirm(`Excluir a pasta “${sup.name}”? As fichas não são apagadas: vão para “Sem fornecedor”.`)) return;
    try {
      await suppliersApi.remove(sup.id);
      setSuppliers((prev) => prev.filter((x) => x.id !== sup.id));
      setItems((prev) => prev?.map((s) => (same(s.supplier, sup.name) ? { ...s, supplier: null } : s)) ?? null);
      if (same(form.supplier, sup.name)) setForm((f) => ({ ...f, supplier: '' }));
      setFolder('all');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível excluir a pasta.');
    }
  }

  function imported(created: PricingStudyDto[]) {
    setImporting(false);
    setItems((prev) => [...created, ...(prev ?? [])]);
    if (created[0]) open(created[0]);
  }

  /** Preço da cotação mudou: o custo acompanha com o % do fornecedor. */
  function editSupplierCost(v: string) {
    const c = parse(v);
    edit({ supplierCost: v, cost: c === null ? '' : toInput(costWithMarkup(c, markup)) });
  }

  const term = q.trim().toLowerCase();
  const inFolder = (s: PricingStudyDto) =>
    folder === 'all' ? true : folder === 'none' ? !s.supplier?.trim() : same(s.supplier, current?.name);
  const shown = (items ?? []).filter((s) => inFolder(s) && (!term || [s.title, s.supplier ?? '', s.quoteRef ?? ''].some((v) => v.toLowerCase().includes(term))));
  const count = (f: (s: PricingStudyDto) => boolean) => (items ?? []).filter(f).length;
  const noSupplier = count((s) => !s.supplier?.trim());

  const field = (k: Exclude<keyof Form, 'category' | 'listingType' | 'quoteRef' | 'quoteItem'>, label: string, opts: { prefix?: string; suffix?: string; placeholder?: string; decimal?: boolean } = {}) => (
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
        <nav className="pfolders" aria-label="Pastas por fornecedor">
          <button type="button" aria-pressed={folder === 'all'} onClick={() => setFolder('all')}>Todas <span>{items?.length ?? 0}</span></button>
          {suppliers.map((x) => (
            <button key={x.id} type="button" aria-pressed={folder === x.id} onClick={() => setFolder(x.id)}>
              {x.name} <span>{count((s) => same(s.supplier, x.name))}</span>
            </button>
          ))}
          {noSupplier > 0 && (
            <button type="button" aria-pressed={folder === 'none'} onClick={() => setFolder('none')}>Sem fornecedor <span>{noSupplier}</span></button>
          )}
          {canManage && <button type="button" className="pfolders-add" onClick={() => void newSupplier()}>+ Fornecedor</button>}
        </nav>
        {current && (
          <div className="pfolder">
            <span>
              <strong>{current.name}</strong>
              <small>Custo = cotação + {pctText(current.costMarkupPct)}%</small>
            </span>
            {canManage && (
              <>
                <button type="button" className="act act-strong" onClick={() => setImporting(true)}>Importar cotação</button>
                <span className="pfolder-links">
                  <button type="button" className="link" onClick={() => changeMarkup(current)}>alterar %</button>
                  <button type="button" className="link" onClick={() => renameSupplier(current)}>renomear</button>
                  <button type="button" className="link link-danger" onClick={() => void removeSupplier(current)}>excluir pasta</button>
                </span>
              </>
            )}
          </div>
        )}
        <label className="search">
          <span className="sr-only">Buscar pesquisa</span>
          <input placeholder="Buscar produto ou fornecedor" value={q} onChange={(e) => setQ(e.target.value)} />
        </label>
        {items && !items.length && <p className="pstudy-empty">Nenhuma pesquisa ainda. Preencha a ficha ao lado e salve para montar sua lista.</p>}
        {items && items.length > 0 && !shown.length && (
          <p className="pstudy-empty">{current ? `Nada em ${current.name} ainda. Importe a cotação ou crie uma ficha com esse fornecedor.` : 'Nenhuma pesquisa encontrada.'}</p>
        )}
        <ul>
          {shown.map((s) => (
            <li key={s.id}>
              <button type="button" aria-current={s.id === selected || undefined} onClick={() => open(s)}>
                <strong>{s.title}</strong>
                <small>{[folder === 'all' ? s.supplier : null, s.cost === null ? null : `custo ${money(s.cost)}`, s.price === null ? null : money(s.price)].filter(Boolean).join(' · ') || '—'}</small>
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
                <label className="sku-input">
                  <small>Fornecedor</small>
                  <span className="sku-field">
                    <input list="pstudy-suppliers" value={form.supplier} placeholder="Ex.: Distribuidora X" onChange={(e) => edit({ supplier: e.target.value })} />
                  </span>
                  <datalist id="pstudy-suppliers">{suppliers.map((x) => <option key={x.id} value={x.name} />)}</datalist>
                </label>
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
                {form.supplierCost ? (
                  <label className="sku-input">
                    <small>Preço na cotação</small>
                    <span className="sku-field">
                      <i>R$</i>
                      <input inputMode="decimal" value={form.supplierCost} onChange={(e) => editSupplierCost(e.target.value)} />
                    </span>
                  </label>
                ) : (
                  field('cost', 'Custo do produto', { prefix: 'R$', placeholder: '0,00', decimal: true })
                )}
                {field('price', 'Valor de venda', { prefix: 'R$', placeholder: '0,00', decimal: true })}
                <label className="sku-input">
                  <small>
                    Comissão {form.listingType ? `· ${form.listingType === 'gold_pro' ? 'Premium' : 'Clássico'}` : ''}
                    <button type="button" className="link pstudy-open" onClick={() => setBrowsing((v) => !v)}>
                      {browsing ? 'fechar lista' : form.category ? 'trocar categoria' : 'escolher na lista'}
                    </button>
                  </small>
                  <span className="sku-field">
                    <input inputMode="decimal" value={form.feePct} placeholder="ex.: 11,5" onChange={(e) => edit({ feePct: e.target.value, listingType: null })} />
                    <i>%</i>
                  </span>
                </label>
                {field('taxPct', 'Imposto', { suffix: '%', decimal: true })}
                {field('packaging', 'Embalagem', { prefix: 'R$', decimal: true })}
              </div>
              {form.category && (
                <div className="pcat-chosen pstudy-cat">
                  <span>
                    <small>Categoria</small>
                    <strong>{form.category.name}</strong>
                  </span>
                  <div className="seg" role="radiogroup" aria-label="Tipo de anúncio">
                    {(['gold_special', 'gold_pro'] as const).map((t) => {
                      const fee = typeFee(form.category!, t);
                      return (
                        <button key={t} type="button" role="radio" aria-checked={form.listingType === t} disabled={fee == null} onClick={() => chooseType(t)}>
                          {t === 'gold_pro' ? 'Premium' : 'Clássico'} <span>{fee == null ? '—' : `${feeText(fee)}%`}</span>
                        </button>
                      );
                    })}
                  </div>
                  <button type="button" className="link" onClick={() => edit({ category: null, listingType: null })}>remover</button>
                </div>
              )}
              {browsing && (
                <CategoryBrowser
                  title="Categoria do produto"
                  onPick={(id) => void pickCategory(id)}
                  onSkip={() => {
                    setBrowsing(false);
                    chooseType(form.listingType ?? 'gold_special', { id: null, name: 'Sem categoria (tarifa média)', feeClassic: 12, feePremium: 17 });
                  }}
                />
              )}
              {form.supplierCost && (
                <div className="pquote-origin">
                  <span>
                    <small>Custo vindo da cotação{form.quoteRef ? ` “${form.quoteRef}”` : ''}</small>
                    <strong>
                      {money(parse(form.supplierCost) ?? 0)} + {pctText(markup)}% {formSupplier ? `(${formSupplier.name})` : ''} = {money(input.cost ?? 0)}
                    </strong>
                    {form.quoteItem && !same(form.quoteItem, form.title) && <small>Item na cotação: “{form.quoteItem}”</small>}
                  </span>
                  <button type="button" className="link" onClick={() => edit({ supplierCost: '' })}>digitar custo à mão</button>
                </div>
              )}
              {!form.category && !browsing && (
                <p className="lprice-note">Digite a % da comissão ou escolha a categoria na lista para puxar a tarifa do Clássico ou do Premium.</p>
              )}
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

      <Modal open={importing} onClose={() => setImporting(false)} label="Importar cotação do fornecedor" wide>
        {current && <QuoteImport supplier={current} taxPct={parse(companyTax) ?? 0} onDone={imported} />}
      </Modal>
    </div>
  );
}
