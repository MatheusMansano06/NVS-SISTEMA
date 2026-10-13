import { useState, type FormEvent } from 'react';
import { forgotPasswordSchema } from '@nvs/shared';
import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { authApi } from '../auth-api';
import { useForm } from '../useForm';

export function ForgotForm({ initialEmail, onBack }: { initialEmail: string; onBack: () => void }) {
  const f = useForm({ email: initialEmail });
  const [sent, setSent] = useState(false);

  function submit(e: FormEvent) {
    e.preventDefault();
    const data = f.validate(forgotPasswordSchema, f.values);
    if (!data) return;
    void f.run(async () => {
      await authApi.forgotPassword(data.email);
      setSent(true);
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="forgot-title">
      <h2 id="forgot-title">Recuperar senha</h2>
      <p className="lead">Informe seu e-mail e enviaremos as instruções de recuperação.</p>

      {sent ? (
        <p className="banner banner-ok" role="status">
          Se este e-mail estiver cadastrado, você receberá as instruções em instantes.
        </p>
      ) : (
        <>
          {f.formError && <p className="banner banner-error" role="alert">{f.formError}</p>}
          <Field
            label="E-mail"
            type="email"
            autoComplete="email"
            inputMode="email"
            placeholder="voce@empresa.com.br"
            value={f.values.email}
            error={f.errors.email}
            onValueChange={f.set('email')}
            autoFocus
          />
          <Button type="submit" loading={f.busy}>
            {f.busy ? 'Enviando…' : 'Enviar instruções'}
          </Button>
        </>
      )}

      <p className="switch">
        <button type="button" className="link" onClick={onBack}>
          Voltar para o login
        </button>
      </p>
    </form>
  );
}
