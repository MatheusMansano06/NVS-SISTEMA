import type { FormEvent } from 'react';
import { loginSchema } from '@nvs/shared';
import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { authApi } from '../auth-api';
import { useAuth } from '../AuthContext';
import { useForm } from '../useForm';

interface Props {
  initialEmail: string;
  notice: string;
  onForgot: (email: string) => void;
  onRegister: () => void;
}

export function LoginForm({ initialEmail, notice, onForgot, onRegister }: Props) {
  const { setSession } = useAuth();
  const f = useForm<{ email: string; password: string; remember: boolean }>({
    email: initialEmail,
    password: '',
    remember: false,
  });

  function submit(e: FormEvent) {
    e.preventDefault();
    const data = f.validate(loginSchema, f.values);
    if (!data) return;
    void f.run(async () => setSession(await authApi.login(data)));
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="login-title">
      <h2 id="login-title">Bem-vindo de volta</h2>
      <p className="lead">Acesse sua conta para continuar.</p>

      {notice && <p className="banner banner-ok" role="status">{notice}</p>}
      {f.formError && <p className="banner banner-error" role="alert">{f.formError}</p>}

      <Field
        label="E-mail"
        type="email"
        autoComplete="username"
        inputMode="email"
        placeholder="voce@empresa.com.br"
        value={f.values.email}
        error={f.errors.email}
        onValueChange={f.set('email')}
        autoFocus={!initialEmail}
      />
      <Field
        label="Senha"
        revealable
        type="password"
        autoComplete="current-password"
        placeholder="Sua senha"
        value={f.values.password}
        error={f.errors.password}
        hint="Primeiro acesso? Use o CNPJ da empresa como senha."
        onValueChange={f.set('password')}
        autoFocus={!!initialEmail}
      />

      <div className="row">
        <label className="check">
          <input
            type="checkbox"
            checked={f.values.remember}
            onChange={(e) => f.set('remember')(e.target.checked)}
          />
          <span>Lembrar acesso</span>
        </label>
        <button type="button" className="link" onClick={() => onForgot(f.values.email)}>
          Esqueci minha senha
        </button>
      </div>

      <Button type="submit" loading={f.busy}>
        {f.busy ? 'Entrando…' : 'Entrar'}
      </Button>

      <p className="switch">
        Ainda não tem conta?{' '}
        <button type="button" className="link" onClick={onRegister}>
          Criar conta
        </button>
      </p>
    </form>
  );
}
