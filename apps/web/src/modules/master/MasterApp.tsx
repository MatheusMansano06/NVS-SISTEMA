import { useEffect, useState, type FormEvent } from 'react';
import type { AdminDto } from '@nvs/shared';
import { navigate, usePath } from '../../app/router';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { AdminsView } from './AdminsView';
import { AnnouncementsView } from './AnnouncementsView';
import { CouponsView, InvoicesView, PlansView } from './BillingViews';
import { OverviewView } from './OverviewView';
import { TenantDetailView, TenantsView } from './TenantsView';
import { masterApi } from './master-api';
import '../skus/skus.css';
import './master.css';

const NAV = [
  { path: '', label: 'Visão geral', icon: '◎' },
  { path: '/empresas', label: 'Empresas', icon: '▦' },
  { path: '/mensalidades', label: 'Mensalidades', icon: '₢' },
  { path: '/cupons', label: 'Cupons', icon: '%' },
  { path: '/planos', label: 'Planos', icon: '◇' },
  { path: '/comunicados', label: 'Comunicados', icon: '✉' },
  { path: '/administradores', label: 'Masters e registro', icon: '⚑' },
];

/** Painel Master do NVS Tech (/master): área do dono da plataforma, com login próprio. */
export function MasterApp() {
  const [admin, setAdmin] = useState<AdminDto | null | undefined>(undefined);
  useEffect(() => {
    masterApi.me().then(setAdmin).catch(() => setAdmin(null));
  }, []);
  if (admin === undefined) return <div className="boot" role="status" aria-label="Carregando"><img src="/nvs-logo.webp" alt="" /></div>;
  if (!admin) return <MasterLogin onIn={setAdmin} />;
  return <MasterShell admin={admin} onOut={() => setAdmin(null)} />;
}

function MasterLogin({ onIn }: { onIn: (a: AdminDto) => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onIn(await masterApi.login(email, password));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ms-login">
      <form className="ms-login-card" onSubmit={submit}>
        <img src="/nvs-logo.webp" alt="NVS Tech" width="150" />
        <p className="ms-kicker">Painel Master</p>
        <h1>Área do dono da plataforma</h1>
        <p className="ms-sub">Contas, mensalidades, cupons e comunicados de todas as empresas.</p>
        <label className="ms-field">
          <span>E-mail</span>
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required autoFocus />
        </label>
        <label className="ms-field">
          <span>Senha</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        <Button type="submit" loading={busy}>Entrar</Button>
        <button type="button" className="link" onClick={() => navigate('/')}>← Voltar para o login das empresas</button>
      </form>
    </div>
  );
}

function MasterShell({ admin, onOut }: { admin: AdminDto; onOut: () => void }) {
  const path = usePath();
  const sub = path.replace(/^\/master/, '');
  const go = (p: string) => navigate(`/master${p}`);
  const tenantId = /^\/empresas\/([0-9a-f-]{36})/.exec(sub)?.[1];
  const active = NAV.slice(1).find((n) => sub.startsWith(n.path))?.path ?? '';

  let body;
  if (tenantId) body = <TenantDetailView id={tenantId} onBack={() => go('/empresas')} />;
  else if (sub.startsWith('/empresas')) body = <TenantsView onOpen={(id) => go(`/empresas/${id}`)} />;
  else if (sub.startsWith('/mensalidades')) body = <InvoicesView onOpenTenant={(id) => go(`/empresas/${id}`)} />;
  else if (sub.startsWith('/cupons')) body = <CouponsView />;
  else if (sub.startsWith('/planos')) body = <PlansView />;
  else if (sub.startsWith('/comunicados')) body = <AnnouncementsView />;
  else if (sub.startsWith('/administradores')) body = <AdminsView me={admin} />;
  else body = <OverviewView go={go} />;

  return (
    <div className="ms">
      <aside className="ms-side" aria-label="Menu do Painel Master">
        <div className="ms-brand">
          <img src="/nvs-logo.webp" alt="NVS Tech" />
          <span>Master</span>
        </div>
        <nav>
          {NAV.map((n) => (
            <a
              key={n.path}
              href={`/master${n.path}`}
              aria-current={active === n.path ? 'page' : undefined}
              onClick={(e) => {
                e.preventDefault();
                go(n.path);
              }}
            >
              <i aria-hidden="true">{n.icon}</i>
              {n.label}
            </a>
          ))}
        </nav>
        <div className="ms-me">
          <span className="ms-avatar" aria-hidden="true">{admin.name.charAt(0).toUpperCase()}</span>
          <span><b>{admin.name}</b><small>{admin.email}</small></span>
          <button type="button" className="link" onClick={() => void masterApi.logout().then(onOut)}>Sair</button>
        </div>
      </aside>
      <main className="ms-main">{body}</main>
    </div>
  );
}
