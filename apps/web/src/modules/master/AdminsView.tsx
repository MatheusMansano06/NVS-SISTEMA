import { useEffect, useState, type FormEvent } from 'react';
import type { AdminDto, AuditDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { masterApi } from './master-api';

const ACTION: Record<string, string> = {
  login: 'Entrou no painel', 'admin.create': 'Criou uma master', 'admin.activate': 'Reativou uma master', 'admin.deactivate': 'Desativou uma master',
  'tenant.suspend': 'Suspendeu empresa', 'tenant.activate': 'Reativou empresa', 'user.reset_password': 'Redefiniu senha',
  'subscription.save': 'Salvou assinatura', 'plan.create': 'Criou plano', 'plan.update': 'Alterou plano',
  'coupon.create': 'Criou cupom', 'coupon.update': 'Alterou cupom', 'coupon.delete': 'Apagou cupom',
  'invoice.generate': 'Gerou mensalidades', 'invoice.create': 'Criou cobrança avulsa', 'invoice.pay': 'Registrou pagamento',
  'invoice.cancel': 'Cancelou cobrança', 'invoice.reopen': 'Reabriu cobrança', 'announcement.create': 'Publicou comunicado',
  'announcement.end': 'Encerrou comunicado', 'announcement.activate': 'Reativou comunicado',
};

/** Contas master (quem acessa este painel) e o registro de tudo que foi feito aqui. */
export function AdminsView({ me }: { me: AdminDto }) {
  const [admins, setAdmins] = useState<AdminDto[] | null>(null);
  const [audit, setAudit] = useState<AuditDto[] | null>(null);
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const load = () => {
    void masterApi.admins().then(setAdmins).catch(() => setAdmins([]));
    void masterApi.audit().then(setAudit).catch(() => setAudit([]));
  };
  useEffect(load, []);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError('');
    try {
      await masterApi.createAdmin(f);
      setNote(`Conta master criada para ${f.email}.`);
      setF({ name: '', email: '', password: '' });
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível criar.');
    }
  }

  return (
    <div className="ms-page">
      <header className="ms-head"><div><p className="dash-kicker">Painel Master</p><h1>Masters e registro</h1></div></header>
      <div className="ms-two ms-two-wide">
        <section className="ms-card">
          <h2>Quem acessa o Painel Master</h2>
          <ul className="ms-list">
            {(admins ?? []).map((a) => (
              <li key={a.id}>
                <span><b>{a.name}</b><small>{a.email}{a.lastLoginAt ? ` · último acesso ${new Date(a.lastLoginAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}` : ''}</small></span>
                {a.id === me.id ? <small>você</small> : (
                  <button type="button" className={a.isActive ? 'act act-danger' : 'act'} onClick={() => void masterApi.adminActive(a.id, !a.isActive).then(load)}>
                    {a.isActive ? 'Desativar' : 'Reativar'}
                  </button>
                )}
              </li>
            ))}
          </ul>
          <form className="ms-form" onSubmit={submit}>
            <h3>Nova conta master</h3>
            <div className="ms-grid">
              <label><small>Nome</small><input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required /></label>
              <label><small>E-mail</small><input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required /></label>
            </div>
            <label><small>Senha (mínimo 10 caracteres)</small><input type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} minLength={10} required autoComplete="new-password" /></label>
            {error && <p className="banner banner-error">{error}</p>}
            {note && <p className="banner banner-ok">{note}</p>}
            <Button type="submit" className="btn-sm">Criar conta master</Button>
          </form>
        </section>
        <section className="ms-card">
          <h2>Registro de ações</h2>
          {!audit ? <div className="promo-skel" aria-hidden="true" /> : (
            <ul className="ms-audit">
              {audit.map((a) => (
                <li key={a.id}>
                  <small>{new Date(a.createdAt).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</small>
                  <span><b>{a.adminName ?? '—'}</b> · {ACTION[a.action] ?? a.action}{a.target ? <small> {a.target}</small> : null}</span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </div>
  );
}
