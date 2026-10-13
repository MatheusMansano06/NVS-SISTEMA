import type { FormEvent } from 'react';
import { changePasswordSchema } from '@nvs/shared';
import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { authApi } from '../auth-api';
import { useAuth } from '../AuthContext';
import { useForm } from '../useForm';

/** Troca de senha (dentro do sistema). No primeiro acesso, a senha atual é o CNPJ. */
export function ChangePasswordForm({ onSuccess }: { onSuccess?: () => void }) {
  const { setSession } = useAuth();
  const f = useForm({ currentPassword: '', newPassword: '', confirm: '' });

  function submit(e: FormEvent) {
    e.preventDefault();
    const data = f.validate(changePasswordSchema, {
      currentPassword: f.values.currentPassword,
      newPassword: f.values.newPassword,
    });
    if (!data) return;
    if (f.values.newPassword !== f.values.confirm) {
      f.setFieldError('confirm', 'As senhas não conferem');
      return;
    }
    void f.run(async () => {
      setSession(await authApi.changePassword(data));
      onSuccess?.();
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="chg-title">
      <h2 id="chg-title">Alterar senha</h2>
      <p className="lead">Se ainda usa a senha provisória, a senha atual é o CNPJ da empresa.</p>
      {f.formError && <p className="banner banner-error" role="alert">{f.formError}</p>}
      <Field label="Senha atual" revealable type="password" autoComplete="current-password"
        value={f.values.currentPassword} error={f.errors.currentPassword} onValueChange={f.set('currentPassword')} autoFocus />
      <Field label="Nova senha" revealable type="password" autoComplete="new-password"
        hint="Mínimo de 10 caracteres, com letras e números."
        value={f.values.newPassword} error={f.errors.newPassword} onValueChange={f.set('newPassword')} />
      <Field label="Confirmar nova senha" revealable type="password" autoComplete="new-password"
        value={f.values.confirm} error={f.errors.confirm} onValueChange={f.set('confirm')} />
      <Button type="submit" loading={f.busy}>{f.busy ? 'Salvando…' : 'Salvar nova senha'}</Button>
    </form>
  );
}
