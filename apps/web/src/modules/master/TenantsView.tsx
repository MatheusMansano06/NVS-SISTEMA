import { useEffect, useState, type FormEvent } from 'react';
import type { PlanDto, SubscriptionStatus, TenantDetailDto, TenantRowDto } from '@nvs/shared';
import { int, money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { Modal } from '../../shared/ui/Modal';
import { InvoiceTable } from './BillingViews';
import { SUB_LABEL, brDate, masterApi } from './master-api';

const cnpjFmt = (c: string | null) => (c ? c.replace(/^(\d{2})(\d{3})(\d{3})(\d{4})(\d{2})$/, '$1.$2.$3/$4-$5') : '—');
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível concluir.');

/** Todas as empresas cadastradas, com busca por nome, CNPJ ou e-mail. */
export function TenantsView({ onOpen }: { onOpen: (id: string) => void }) {
  const [q, setQ] = useState('');
  const [rows, setRows] = useState<TenantRowDto[] | null>(null);
  useEffect(() => {
    const t = window.setTimeout(() => void masterApi.tenants(q).then(setRows).catch(() => setRows([])), 250);
    return () => window.clearTimeout(t);
  }, [q]);
  return (
    <div className="ms-page">
      <header className="ms-head">
        <div><p className="dash-kicker">Painel Master</p><h1>Empresas</h1></div>
        <label className="search ms-search">
          <span aria-hidden="true">🔎</span>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Nome, CNPJ ou e-mail…" aria-label="Buscar empresa" />
        </label>
      </header>
      {!rows ? <div className="promo-skel" aria-hidden="true" /> : (
        <section className="ms-card ms-table-card">
          <table className="ms-table">
            <thead><tr><th>Empresa</th><th>Contato</th><th>Assinatura</th><th>Mercado Livre</th><th>Situação</th><th>Desde</th></tr></thead>
            <tbody>
              {rows.map((t) => (
                <tr key={t.id} onClick={() => onOpen(t.id)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpen(t.id)}>
                  <td><b>{t.name}</b><small>{cnpjFmt(t.cnpj)}</small></td>
                  <td>{t.ownerEmail ?? '—'}<small>{t.phone ?? ''} · {t.users} usuário(s)</small></td>
                  <td>{t.subscription ? <><span className="ms-pill" data-s={t.subscription.status}>{SUB_LABEL[t.subscription.status]}</span><small>{t.subscription.planName ?? 'Valor combinado'} · {t.subscription.price === null ? '—' : money(t.subscription.price)}</small></> : <span className="ms-pill">Sem assinatura</span>}</td>
                  <td>{t.mlConnected ? '✓ Conectado' : '—'}</td>
                  <td>{t.status === 'suspended' ? <span className="ms-pill" data-s="canceled">Suspensa</span> : t.overdue ? <span className="ms-pill" data-s="past_due">{t.overdue} em atraso</span> : <span className="ms-pill" data-s="active">Em dia</span>}</td>
                  <td>{brDate(t.createdAt.slice(0, 10))}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {!rows.length && <p className="ms-sub ms-empty">Nenhuma empresa encontrada.</p>}
        </section>
      )}
    </div>
  );
}

/** Ficha da empresa: pessoas (redefinir senha), Mercado Livre, vendas, assinatura e mensalidades; suspender/reativar. */
export function TenantDetailView({ id, onBack }: { id: string; onBack: () => void }) {
  const [t, setT] = useState<TenantDetailDto | null>(null);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [reset, setReset] = useState<{ email: string; temporaryPassword: string } | null>(null);
  const [editSub, setEditSub] = useState(false);
  const load = () => masterApi.tenant(id).then(setT).catch((e) => setError(errMsg(e)));
  useEffect(() => void load(), [id]); // recarrega ao trocar de empresa

  async function toggleStatus() {
    if (!t) return;
    const next = t.status === 'active' ? 'suspended' : 'active';
    if (next === 'suspended' && !window.confirm(`Suspender ${t.name}? Ninguém da empresa consegue entrar até reativar.`)) return;
    try {
      await masterApi.tenantStatus(id, next);
      setNote(next === 'suspended' ? 'Empresa suspensa: o acesso foi cortado na hora.' : 'Empresa reativada.');
      void load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  async function resetPassword(userId: string, name: string) {
    if (!window.confirm(`Gerar uma senha provisória para ${name}? A senha atual deixa de funcionar.`)) return;
    try {
      setReset(await masterApi.resetPassword(id, userId));
      void load();
    } catch (e) {
      setError(errMsg(e));
    }
  }

  if (error && !t) return <p className="banner banner-error">{error}</p>;
  if (!t) return <div className="promo-skel" aria-hidden="true" />;
  return (
    <div className="ms-page">
      <button type="button" className="link" onClick={onBack}>‹ Empresas</button>
      <header className="ms-head">
        <div>
          <p className="dash-kicker">{cnpjFmt(t.cnpj)} · desde {brDate(t.createdAt.slice(0, 10))}</p>
          <h1>{t.name}</h1>
        </div>
        <div className="ms-actions">
          {t.status === 'suspended' ? <span className="ms-pill" data-s="canceled">Suspensa</span> : <span className="ms-pill" data-s="active">Ativa</span>}
          <button type="button" className={`act${t.status === 'active' ? ' act-danger' : ''}`} onClick={() => void toggleStatus()}>
            {t.status === 'active' ? 'Suspender acesso' : 'Reativar acesso'}
          </button>
        </div>
      </header>
      {note && <p className="banner banner-ok">{note}</p>}
      {error && <p className="banner banner-error">{error}</p>}

      <section className="ms-kpis ms-kpis-3">
        <div className="ms-kpi"><small>Vendas em 30 dias</small><b>{int(t.sales30.orders)}</b><span>{money(t.sales30.revenue)} faturados</span></div>
        <div className="ms-kpi"><small>Mercado Livre</small><b>{t.mlAccounts.length}</b><span>{t.mlAccounts.map((m) => m.nickname).join(', ') || 'nenhuma conta conectada'}</span></div>
        <button type="button" className="ms-kpi" onClick={() => setEditSub(true)}>
          <small>Assinatura</small>
          <b>{t.subscriptionDetail ? SUB_LABEL[t.subscriptionDetail.status] : 'Sem assinatura'}</b>
          <span>{t.subscription ? `${t.subscription.planName ?? 'Valor combinado'} · ${t.subscription.price === null ? '—' : money(t.subscription.price)} · vence dia ${t.subscriptionDetail?.billingDay}` : 'Clique para criar'}{t.subscriptionDetail?.couponCode ? ` · cupom ${t.subscriptionDetail.couponCode}` : ''}</span>
        </button>
      </section>

      <section className="ms-card">
        <h2>Pessoas com acesso</h2>
        <table className="ms-table">
          <thead><tr><th>Nome</th><th>E-mail</th><th>Papel</th><th>Situação</th><th /></tr></thead>
          <tbody>
            {t.people.map((p) => (
              <tr key={p.id}>
                <td><b>{p.name}</b></td>
                <td>{p.email}</td>
                <td>{p.role === 'owner' ? 'Dono' : p.role === 'admin' ? 'Administrador' : p.role === 'member' ? 'Membro' : 'Leitura'}</td>
                <td>{!p.isActive ? 'Desativado' : p.mustChangePassword ? 'Precisa trocar a senha' : 'Ativo'}</td>
                <td className="ms-right"><button type="button" className="act" onClick={() => void resetPassword(p.id, p.name)}>Redefinir senha</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="ms-card">
        <h2>Mensalidades</h2>
        <InvoiceTable rows={t.invoices} onChanged={() => void load()} hideTenant />
      </section>

      <Modal open={reset !== null} onClose={() => setReset(null)} label="Senha provisória">
        {reset && (
          <div className="full-modal">
            <h2>Senha provisória gerada</h2>
            <p>Passe para <b>{reset.email}</b>. Ao entrar com ela, o sistema pede para criar uma senha nova.</p>
            <p className="ms-temp" data-autofocus tabIndex={0}>{reset.temporaryPassword}</p>
            <p className="ms-sub">Ela aparece só agora. Se perder, gere outra.</p>
            <div className="full-modal-acts">
              <button type="button" className="act" onClick={() => void navigator.clipboard?.writeText(reset.temporaryPassword)}>Copiar</button>
              <button type="button" className="full-dark-btn" onClick={() => setReset(null)}>Pronto</button>
            </div>
          </div>
        )}
      </Modal>
      <Modal open={editSub} onClose={() => setEditSub(false)} label="Assinatura" wide>
        {editSub && <SubscriptionForm tenant={t} onDone={() => { setEditSub(false); setNote('Assinatura salva.'); void load(); }} />}
      </Modal>
    </div>
  );
}

function SubscriptionForm({ tenant, onDone }: { tenant: TenantDetailDto; onDone: () => void }) {
  const s = tenant.subscriptionDetail;
  const [plans, setPlans] = useState<PlanDto[]>([]);
  const [planId, setPlanId] = useState(s?.planId ?? '');
  const [price, setPrice] = useState(s?.price === null || s?.price === undefined ? '' : String(s.price));
  const [status, setStatus] = useState<SubscriptionStatus>(s?.status ?? 'trial');
  const [trialEndsOn, setTrialEndsOn] = useState(s?.trialEndsOn ?? '');
  const [billingDay, setBillingDay] = useState(String(s?.billingDay ?? 10));
  const [couponCode, setCouponCode] = useState(s?.couponCode ?? '');
  const [notes, setNotes] = useState(s?.notes ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => void masterApi.plans().then(setPlans).catch(() => undefined), []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await masterApi.saveSubscription(tenant.id, {
        planId: planId || null, price: price.trim() === '' ? null : Number(price.replace(',', '.')), status, trialEndsOn: trialEndsOn || null,
        billingDay: Number(billingDay), couponCode: couponCode.trim() || null, notes: notes.trim() || null,
      });
      onDone();
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="full-modal ms-form" onSubmit={submit}>
      <h2>Assinatura de {tenant.name}</h2>
      <div className="ms-grid">
        <label><small>Plano</small>
          <select value={planId} onChange={(e) => setPlanId(e.target.value)}>
            <option value="">Sem plano (valor combinado)</option>
            {plans.filter((p) => p.active || p.id === planId).map((p) => <option key={p.id} value={p.id}>{p.name} · {money(p.price)}</option>)}
          </select>
        </label>
        <label><small>Valor combinado (vazio = do plano)</small><input inputMode="decimal" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="Ex.: 149,90" /></label>
        <label><small>Situação</small>
          <select value={status} onChange={(e) => setStatus(e.target.value as SubscriptionStatus)}>
            {(Object.keys(SUB_LABEL) as SubscriptionStatus[]).map((k) => <option key={k} value={k}>{SUB_LABEL[k]}</option>)}
          </select>
        </label>
        <label><small>Fim do teste grátis</small><input type="date" value={trialEndsOn} onChange={(e) => setTrialEndsOn(e.target.value)} /></label>
        <label><small>Dia do vencimento (1 a 28)</small><input type="number" min={1} max={28} value={billingDay} onChange={(e) => setBillingDay(e.target.value)} /></label>
        <label><small>Cupom de desconto</small><input value={couponCode} onChange={(e) => setCouponCode(e.target.value.toUpperCase())} placeholder="Ex.: BEMVINDO20" /></label>
      </div>
      {s?.couponCode && <p className="ms-sub">Cupom atual: {s.couponCode}{s.couponCyclesLeft === null ? ' (vale sempre)' : ` · faltam ${s.couponCyclesLeft} mensalidade(s) com desconto`}</p>}
      <label><small>Observações</small><textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} /></label>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit" loading={busy}>Salvar assinatura</Button>
    </form>
  );
}
