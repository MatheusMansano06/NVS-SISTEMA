import { useState } from 'react';
import { FluidBackground } from '../../shared/ui/FluidBackground';
import { LoginForm } from './forms/LoginForm';
import { RegisterForm } from './forms/RegisterForm';
import { ForgotForm } from './forms/ForgotForm';
import { usePointerGlow } from '../../shared/ui/usePointerGlow';
import { navigate } from '../../app/router';
import './auth.css';

type View = 'login' | 'register' | 'forgot';

export function AuthPage() {
  const [view, setView] = useState<View>('login');
  const [notice, setNotice] = useState('');
  const [email, setEmail] = useState('');
  const ref = usePointerGlow<HTMLDivElement>();

  const go = (next: View, message = '') => {
    setNotice(message);
    setView(next);
  };

  return (
    <div className="auth" ref={ref}>
      <FluidBackground />
      <section className="auth-brand">
        <img src="/nvs-logo.webp" alt="NVS Tech" width="260" height="120" className="auth-logo" />
        <h1>
          Sua operação,
          <br />
          <span>organizada em um só lugar.</span>
        </h1>
        <p>Financeiro, rotinas e marketplaces conectados pela NVS Tech.</p>
        <button type="button" className="link auth-master" onClick={() => navigate('/master')}>Acesso master →</button>
      </section>

      <main className="auth-panel" data-glow>
        <div key={view} className="auth-view">
          {view === 'login' && (
            <LoginForm
              initialEmail={email}
              notice={notice}
              onForgot={(e) => {
                setEmail(e);
                go('forgot');
              }}
              onRegister={() => go('register')}
            />
          )}
          {view === 'register' && (
            <RegisterForm
              onBack={() => go('login')}
              onCreated={(e) => {
                setEmail(e);
                go('login', 'Conta criada! Entre com seu e-mail e use o CNPJ como senha provisória.');
              }}
            />
          )}
          {view === 'forgot' && <ForgotForm initialEmail={email} onBack={() => go('login')} />}
        </div>
      </main>
    </div>
  );
}
