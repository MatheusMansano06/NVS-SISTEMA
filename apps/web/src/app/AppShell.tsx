import { useState, type ReactNode } from 'react';
import { useAuth } from '../modules/auth/AuthContext';
import { ChangePasswordForm } from '../modules/auth/forms/ChangePasswordForm';
import { DeleteAccountForm } from '../modules/account/DeleteAccountForm';
import { Icon, type IconName } from '../shared/ui/Icon';
import { Modal } from '../shared/ui/Modal';
import { navigate, usePath } from './router';
import './shell.css';

const NAV: { label: string; icon: IconName; path?: string }[] = [
  { label: 'Dashboard', icon: 'dashboard', path: '/' },
  { label: 'Análise Financeira', icon: 'wallet', path: '/financeiro' },
  { label: 'Cadastro de SKUs', icon: 'box', path: '/skus' },
  { label: 'Vendas', icon: 'cart', path: '/vendas' },
  { label: 'Anúncios', icon: 'megaphone', path: '/anuncios' },
  { label: 'Integrações', icon: 'plug' },
];

/** Estrutura do sistema logado: menu lateral (gaveta no celular) + área de conteúdo. */
export function AppShell({ children }: { children: ReactNode }) {
  const { session, logout } = useAuth();
  const [menuOpen, setMenuOpen] = useState(false);
  const [userMenu, setUserMenu] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [notice, setNotice] = useState('');

  const email = session?.user.email ?? '';
  const path = usePath();

  return (
    <div className="shell" data-menu-open={menuOpen || undefined}>
      <header className="shell-mobilebar">
        <button type="button" className="icon-btn" onClick={() => setMenuOpen(true)} aria-label="Abrir menu">
          <Icon name="menu" />
        </button>
        <img src="/nvs-logo.webp" alt="NVS Tech" height="34" />
      </header>

      <aside className="sidebar" aria-label="Menu principal">
        <div className="sidebar-top">
          <img src="/nvs-logo.webp" alt="NVS Tech" className="sidebar-logo" />
          <button type="button" className="icon-btn sidebar-close" onClick={() => setMenuOpen(false)} aria-label="Fechar menu">
            <Icon name="close" />
          </button>
        </div>
        <nav>
          <ul>
            {NAV.map((item) => (
              <li key={item.label}>
                <a
                  href={item.path}
                  className="nav-item"
                  title={item.label}
                  aria-current={item.path && (item.path === path || (item.path !== '/' && path.startsWith(item.path))) ? 'page' : undefined}
                  aria-disabled={item.path ? undefined : true}
                  onClick={(e) => {
                    e.preventDefault();
                    if (!item.path) return;
                    navigate(item.path);
                    setMenuOpen(false);
                  }}
                >
                  <Icon name={item.icon} />
                  <span>{item.label}</span>
                  {!item.path && <small>em breve</small>}
                </a>
              </li>
            ))}
          </ul>
        </nav>

        <div className="sidebar-user">
          {userMenu && (
            <div className="user-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setUserMenu(false); setChangingPassword(true); }}>
                <Icon name="key" size={18} /> Alterar senha
              </button>
              <button type="button" role="menuitem" onClick={() => void logout()}>
                <Icon name="logout" size={18} /> Sair
              </button>
              {session?.user.role === 'owner' && (
                <button type="button" role="menuitem" className="danger" onClick={() => { setUserMenu(false); setDeleting(true); }}>
                  <Icon name="close" size={18} /> Excluir empresa
                </button>
              )}
            </div>
          )}
          <button type="button" className="user-card" onClick={() => setUserMenu((v) => !v)} aria-expanded={userMenu}>
            <span className="user-avatar" aria-hidden="true">{email.charAt(0).toUpperCase()}</span>
            <span className="user-info">
              <strong>{email.split('@')[0]}</strong>
              <small>{session?.tenant.name}</small>
            </span>
            <Icon name="chevron" size={16} />
          </button>
        </div>
      </aside>
      <button type="button" className="shell-scrim" aria-label="Fechar menu" tabIndex={-1} onClick={() => setMenuOpen(false)} />

      <main className="shell-main">
        {notice && (
          <p className="banner banner-ok shell-notice" role="status" onAnimationEnd={() => undefined}>
            {notice}
          </p>
        )}
        {children}
      </main>

      <Modal open={changingPassword} onClose={() => setChangingPassword(false)} label="Alterar senha">
        <ChangePasswordForm
          onSuccess={() => {
            setChangingPassword(false);
            setNotice('Senha alterada com sucesso.');
            window.setTimeout(() => setNotice(''), 4000);
          }}
        />
      </Modal>
      <Modal open={deleting} onClose={() => setDeleting(false)} label="Excluir empresa">
        <DeleteAccountForm onCancel={() => setDeleting(false)} />
      </Modal>
    </div>
  );
}
