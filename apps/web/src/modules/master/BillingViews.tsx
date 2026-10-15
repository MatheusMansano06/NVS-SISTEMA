import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_TENANT_FEATURES, TENANT_FEATURE_LABELS, TENANT_FEATURES, type CouponDto, type InvoiceDto, type PlanDto, type TenantFeature, type TenantRowDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { Modal } from '../../shared/ui/Modal';
import { FeaturePicker } from './FeaturePicker';
import { SITUATION_LABEL, brDate, masterApi } from './master-api';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir.');
const today = () => new Date().toLocaleDateString('sv-SE');
const thisMonth = () => `${today().slice(0, 7)}-01`;
const monthLabel = (p: string) => `${p.slice(5, 7)}/${p.slice(0, 4)}`;
const toNum = (s: string) => Number(s.replace(/\./g, '').replace(',', '.'));

/** Tabela de mensalidades com as ações (marcar paga, cancelar, reabrir). */
export function InvoiceTable({ rows, onChanged, hideTenant, onOpenTenant }: { rows: InvoiceDto[]; onChanged: () => void; hideTenant?: boolean; onOpenTenant?: (id: string) => void }) {
  const [paying, setPaying] = useState<InvoiceDto | null>(null);
  const [error, setError] = useState('');
  async function setStatus(i: InvoiceDto, status: 'pending' | 'canceled') {
    if (status === 'canceled' && !window.confirm(`Cancelar a cobrança "${i.description}" de ${i.tenantName}?`)) return;
    try {
      await masterApi.invoiceStatus(i.id, status);
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  if (!rows.length) return <p className="ms-sub ms-empty">Nenhuma mensalidade.</p>;
  return (
    <>
      {error && <p className="banner banner-error">{error}</p>}
      <table className="ms-table">
        <thead><tr>{!hideTenant && <th>Empresa</th>}<th>Referência</th><th>Vencimento</th><th className="ms-right">Valor</th><th>Situação</th><th /></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id} data-situation={i.situation}>
              {!hideTenant && <td>{onOpenTenant ? <button type="button" className="link" onClick={() => onOpenTenant(i.tenantId)}>{i.tenantName}</button> : i.tenantName}</td>}
              <td>{i.description}<small>{monthLabel(i.period)}</small></td>
              <td>{brDate(i.dueDate)}</td>
              <td className="ms-right"><b>{money(i.total)}</b>{i.discount > 0 && <small>{money(i.amount)} − {money(i.discount)} ({i.couponCode})</small>}</td>
              <td><span className="ms-pill" data-s={i.situation}>{SITUATION_LABEL[i.situation]}</span>{i.paidAt && <small>{brDate(i.paidAt.slice(0, 10))} · {i.method}</small>}</td>
              <td className="ms-right ms-row-acts">
                {(i.situation === 'pending' || i.situation === 'overdue') && <button type="button" className="act" onClick={() => setPaying(i)}>Marcar paga</button>}
                {i.situation !== 'canceled' && i.situation !== 'paid' && <button type="button" className="act act-danger" onClick={() => void setStatus(i, 'canceled')}>Cancelar</button>}
                {(i.situation === 'canceled' || i.situation === 'paid') && <button type="button" className="link" onClick={() => void setStatus(i, 'pending')}>Reabrir</button>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <Modal open={paying !== null} onClose={() => setPaying(null)} label="Registrar pagamento">
        {paying && <PayForm invoice={paying} onDone={() => { setPaying(null); onChanged(); }} />}
      </Modal>
    </>
  );
}

function PayForm({ invoice, onDone }: { invoice: InvoiceDto; onDone: () => void }) {
  const [method, setMethod] = useState('pix');
  const [paidOn, setPaidOn] = useState(today());
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    try {
      await masterApi.pay(invoice.id, method, paidOn || null);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="full-modal ms-form" onSubmit={submit}>
      <h2>Registrar pagamento</h2>
      <p>{invoice.tenantName} · {invoice.description} · <b>{money(invoice.total)}</b></p>
      <label><small>Forma de pagamento</small>
        <select value={method} onChange={(e) => setMethod(e.target.value)}>
          <option value="pix">Pix</option><option value="boleto">Boleto</option><option value="cartao">Cartão</option>
          <option value="transferencia">Transferência</option><option value="outro">Outro</option>
        </select>
      </label>
      <label><small>Pago em</small><input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} max={today()} /></label>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit" loading={busy}>Confirmar pagamento</Button>
    </form>
  );
}

/** Mensalidades de todas as empresas: gerar as do mês, cobrança avulsa e filtro por situação. */
export function InvoicesView({ onOpenTenant }: { onOpenTenant: (id: string) => void }) {
  const [situation, setSituation] = useState('');
  const [rows, setRows] = useState<InvoiceDto[] | null>(null);
  const [period, setPeriod] = useState(thisMonth());
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const load = () => masterApi.invoices({ situation }).then(setRows).catch((e) => setError(errMsg(e)));
  useEffect(() => void load(), [situation]);

  async function generate() {
    setBusy(true);
    setNote('');
    try {
      const r = await masterApi.generate(period);
      setNote(`${r.created} mensalidade(s) gerada(s) para ${monthLabel(period)}${r.skipped ? ` · ${r.skipped} já existiam` : ''}.`);
      void load();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  const total = (rows ?? []).reduce((s, i) => s + (i.situation === 'canceled' ? 0 : i.total), 0);
  return (
    <div className="ms-page">
      <header className="ms-head">
        <div><p className="dash-kicker">Painel Master</p><h1>Mensalidades</h1></div>
        <div className="ms-actions">
          <input type="month" value={period.slice(0, 7)} onChange={(e) => setPeriod(`${e.target.value}-01`)} aria-label="Mês" className="ms-month" />
          <Button onClick={() => void generate()} loading={busy} className="btn-sm">Gerar mensalidades do mês</Button>
          <button type="button" className="act" onClick={() => setManual(true)}>Cobrança avulsa</button>
        </div>
      </header>
      <p className="ms-sub">Gera uma cobrança por assinatura ativa (ou em atraso), com o desconto do cupom enquanto ele valer. O mesmo mês nunca duplica. Pagamento por enquanto é registrado à mão; integração com Pix/boleto fica para a próxima etapa.</p>
      {note && <p className="banner banner-ok">{note}</p>}
      {error && <p className="banner banner-error">{error}</p>}
      <div className="seg" role="tablist" aria-label="Situação">
        {([['', 'Todas'], ['overdue', 'Em atraso'], ['pending', 'A vencer'], ['paid', 'Pagas'], ['canceled', 'Canceladas']] as const).map(([k, l]) => (
          <button key={k} type="button" role="tab" aria-checked={situation === k} onClick={() => setSituation(k)}>{l}</button>
        ))}
      </div>
      {!rows ? <div className="promo-skel" aria-hidden="true" /> : (
        <section className="ms-card ms-table-card">
          <p className="ms-sub">{rows.length} cobrança(s) · {money(total)}</p>
          <InvoiceTable rows={rows} onChanged={() => void load()} onOpenTenant={onOpenTenant} />
        </section>
      )}
      <Modal open={manual} onClose={() => setManual(false)} label="Cobrança avulsa">
        {manual && <ManualInvoice onDone={() => { setManual(false); void load(); }} />}
      </Modal>
    </div>
  );
}

function ManualInvoice({ onDone }: { onDone: () => void }) {
  const [tenants, setTenants] = useState<TenantRowDto[]>([]);
  const [tenantId, setTenantId] = useState('');
  const [period, setPeriod] = useState(thisMonth().slice(0, 7));
  const [description, setDescription] = useState('Mensalidade');
  const [amount, setAmount] = useState('');
  const [dueDate, setDueDate] = useState(today());
  const [error, setError] = useState('');
  useEffect(() => void masterApi.tenants().then(setTenants).catch(() => undefined), []);
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await masterApi.createInvoice({ tenantId, period: `${period}-01`, description, amount: toNum(amount), dueDate });
      onDone();
    } catch (err) {
      setError(errMsg(err));
    }
  }
  return (
    <form className="full-modal ms-form" onSubmit={submit}>
      <h2>Cobrança avulsa</h2>
      <label><small>Empresa</small>
        <select value={tenantId} onChange={(e) => setTenantId(e.target.value)} required>
          <option value="">Escolha…</option>
          {tenants.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
        </select>
      </label>
      <div className="ms-grid">
        <label><small>Mês de referência</small><input type="month" value={period} onChange={(e) => setPeriod(e.target.value)} required /></label>
        <label><small>Vencimento</small><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} required /></label>
        <label><small>Descrição</small><input value={description} onChange={(e) => setDescription(e.target.value)} required maxLength={120} /></label>
        <label><small>Valor (R$)</small><input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} required placeholder="199,90" /></label>
      </div>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit">Criar cobrança</Button>
    </form>
  );
}

const DURATION = { once: 'Só a 1ª mensalidade', months: 'Por alguns meses', forever: 'Para sempre' } as const;

/** Cupons de desconto (percentual ou valor fixo), com validade, limite de usos e duração. */
export function CouponsView() {
  const [rows, setRows] = useState<CouponDto[] | null>(null);
  const [edit, setEdit] = useState<CouponDto | 'new' | null>(null);
  const [error, setError] = useState('');
  const load = () => masterApi.coupons().then(setRows).catch((e) => setError(errMsg(e)));
  useEffect(() => void load(), []);
  async function remove(c: CouponDto) {
    if (!window.confirm(`Apagar o cupom ${c.code}?`)) return;
    try {
      await masterApi.deleteCoupon(c.id);
      void load();
    } catch (e) {
      setError(errMsg(e));
    }
  }
  return (
    <div className="ms-page">
      <header className="ms-head">
        <div><p className="dash-kicker">Painel Master</p><h1>Cupons de desconto</h1></div>
        <Button className="btn-sm" onClick={() => setEdit('new')}>+ Novo cupom</Button>
      </header>
      {error && <p className="banner banner-error">{error}</p>}
      {!rows ? <div className="promo-skel" aria-hidden="true" /> : (
        <section className="ms-coupons">
          {!rows.length && <p className="ms-sub ms-empty">Nenhum cupom ainda.</p>}
          {rows.map((c) => (
            <article key={c.id} className="ms-coupon" data-off={!c.active || undefined}>
              <header><b>{c.code}</b><span className="ms-pill" data-s={c.active ? 'active' : 'canceled'}>{c.active ? 'Ativo' : 'Desativado'}</span></header>
              <strong>{c.kind === 'percent' ? `${c.value}% off` : `${money(c.value)} off`}</strong>
              <small>{DURATION[c.duration]}{c.duration === 'months' ? ` (${c.months})` : ''}</small>
              <small>Usado {c.redemptions}{c.maxRedemptions ? ` de ${c.maxRedemptions}` : ''} vez(es){c.validUntil ? ` · até ${brDate(c.validUntil)}` : ''}</small>
              {c.description && <p>{c.description}</p>}
              <footer>
                <button type="button" className="act" onClick={() => setEdit(c)}>Editar</button>
                {c.redemptions === 0 && <button type="button" className="link" onClick={() => void remove(c)}>Apagar</button>}
              </footer>
            </article>
          ))}
        </section>
      )}
      <Modal open={edit !== null} onClose={() => setEdit(null)} label="Cupom">
        {edit && <CouponForm coupon={edit === 'new' ? null : edit} onDone={() => { setEdit(null); void load(); }} />}
      </Modal>
    </div>
  );
}

function CouponForm({ coupon, onDone }: { coupon: CouponDto | null; onDone: () => void }) {
  const [f, setF] = useState({
    code: coupon?.code ?? '', description: coupon?.description ?? '', kind: coupon?.kind ?? 'percent', value: coupon ? String(coupon.value) : '',
    duration: coupon?.duration ?? 'once', months: coupon?.months ? String(coupon.months) : '3', maxRedemptions: coupon?.maxRedemptions ? String(coupon.maxRedemptions) : '',
    validUntil: coupon?.validUntil ?? '', active: coupon?.active ?? true,
  });
  const [error, setError] = useState('');
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await masterApi.saveCoupon({
        code: f.code.trim().toUpperCase(), description: f.description.trim() || null, kind: f.kind as CouponDto['kind'], value: toNum(f.value),
        duration: f.duration as CouponDto['duration'], months: f.duration === 'months' ? Number(f.months) : null,
        maxRedemptions: f.maxRedemptions ? Number(f.maxRedemptions) : null, validUntil: f.validUntil || null, active: f.active,
      }, coupon?.id);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    }
  }
  return (
    <form className="full-modal ms-form" onSubmit={submit}>
      <h2>{coupon ? `Cupom ${coupon.code}` : 'Novo cupom'}</h2>
      <div className="ms-grid">
        <label><small>Código</small><input value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} required placeholder="BEMVINDO20" /></label>
        <label><small>Tipo</small>
          <select value={f.kind} onChange={set('kind')}><option value="percent">Percentual (%)</option><option value="fixed">Valor fixo (R$)</option></select>
        </label>
        <label><small>{f.kind === 'percent' ? 'Desconto (%)' : 'Desconto (R$)'}</small><input inputMode="decimal" value={f.value} onChange={set('value')} required /></label>
        <label><small>Vale para</small>
          <select value={f.duration} onChange={set('duration')}>{Object.entries(DURATION).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        </label>
        {f.duration === 'months' && <label><small>Quantos meses</small><input type="number" min={1} max={60} value={f.months} onChange={set('months')} /></label>}
        <label><small>Limite de usos (vazio = sem limite)</small><input type="number" min={1} value={f.maxRedemptions} onChange={set('maxRedemptions')} /></label>
        <label><small>Válido até (vazio = sem prazo)</small><input type="date" value={f.validUntil} onChange={set('validUntil')} /></label>
      </div>
      <label><small>Descrição (interna)</small><input value={f.description} onChange={set('description')} maxLength={200} /></label>
      <label className="full-check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> Ativo</label>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit">Salvar cupom</Button>
    </form>
  );
}

/** Planos de assinatura (preço base); cada empresa pode ter um valor combinado diferente. */
export function PlansView() {
  const [rows, setRows] = useState<PlanDto[] | null>(null);
  const [edit, setEdit] = useState<PlanDto | 'new' | null>(null);
  const load = () => masterApi.plans().then(setRows).catch(() => setRows([]));
  useEffect(() => void load(), []);
  return (
    <div className="ms-page">
      <header className="ms-head">
        <div><p className="dash-kicker">Painel Master</p><h1>Planos</h1></div>
        <Button className="btn-sm" onClick={() => setEdit('new')}>+ Novo plano</Button>
      </header>
      {!rows ? <div className="promo-skel" aria-hidden="true" /> : (
        <section className="ms-coupons">
          {!rows.length && <p className="ms-sub ms-empty">Nenhum plano ainda. Crie o primeiro para usar nas assinaturas.</p>}
          {rows.map((p) => (
            <article key={p.id} className="ms-coupon" data-off={!p.active || undefined}>
              <header><b>{p.name}</b><span className="ms-pill" data-s={p.active ? 'active' : 'canceled'}>{p.active ? 'À venda' : 'Fora de venda'}</span></header>
              <strong>{money(p.price)}<small>/mês</small></strong>
              <small>{p.subscribers} assinante(s)</small>
              {p.description && <p>{p.description}</p>}
              <p className="ms-plan-feats">{p.features.length} de {TENANT_FEATURES.length} recursos · {p.features.map((f) => TENANT_FEATURE_LABELS[f as TenantFeature] ?? f).join(', ')}</p>
              <footer><button type="button" className="act" onClick={() => setEdit(p)}>Editar</button></footer>
            </article>
          ))}
        </section>
      )}
      <Modal open={edit !== null} onClose={() => setEdit(null)} label="Plano">
        {edit && <PlanForm plan={edit === 'new' ? null : edit} onDone={() => { setEdit(null); void load(); }} />}
      </Modal>
    </div>
  );
}

function PlanForm({ plan, onDone }: { plan: PlanDto | null; onDone: () => void }) {
  const [name, setName] = useState(plan?.name ?? '');
  const [price, setPrice] = useState(plan ? String(plan.price) : '');
  const [description, setDescription] = useState(plan?.description ?? '');
  const [active, setActive] = useState(plan?.active ?? true);
  const [features, setFeatures] = useState<string[]>(plan?.features ?? DEFAULT_TENANT_FEATURES);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    try {
      await masterApi.savePlan({ name, price: toNum(price), description: description.trim() || null, active, features: features as TenantFeature[] }, plan?.id);
      onDone();
    } catch (err) {
      setError(errMsg(err));
    }
  }
  return (
    <form className="full-modal ms-form" onSubmit={submit}>
      <h2>{plan ? `Plano ${plan.name}` : 'Novo plano'}</h2>
      <label><small>Nome</small><input value={name} onChange={(e) => setName(e.target.value)} required maxLength={60} /></label>
      <label><small>Preço mensal (R$)</small><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} required /></label>
      <label><small>O que inclui</small><textarea rows={3} value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} /></label>
      <label className="full-check"><input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} /> À venda</label>
      <div>
        <small className="ms-feat-label">Recursos do plano</small>
        <FeaturePicker value={features} onToggle={(f, on) => setFeatures((cur) => (on ? [...cur, f] : cur.filter((x) => x !== f)))} />
        {plan && plan.subscribers > 0 && <p className="ms-muted">Vale na hora para as {plan.subscribers} empresa(s) deste plano que não foram personalizadas.</p>}
      </div>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit">Salvar plano</Button>
    </form>
  );
}
