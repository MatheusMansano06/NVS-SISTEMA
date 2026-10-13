import { useState, type FormEvent } from 'react';
import { Button } from '../../shared/ui/Button';
import { Field } from '../../shared/ui/Field';
import { ApiError, http } from '../../shared/http';
import { maskCnpj } from '../../shared/masks';
import { useAuth } from '../auth/AuthContext';

/** Exclusão definitiva da empresa: exige digitar o CNPJ e a senha (somente o dono). */
export function DeleteAccountForm({ onCancel }: { onCancel: () => void }) {
  const { setSession } = useAuth();
  const [cnpj, setCnpj] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const [formError, setFormError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setErrors({});
    setFormError('');
    try {
      await http<void>('/api/v1/account', { method: 'DELETE', body: { cnpj, password } });
      window.history.replaceState(null, '', '/');
      setSession(null);
    } catch (err) {
      if (err instanceof ApiError) {
        const f = Object.fromEntries(Object.entries(err.fieldErrors).map(([k, v]) => [k, v[0]]));
        setErrors(f);
        if (!Object.keys(f).length) setFormError(err.message);
      } else setFormError('Não foi possível excluir agora.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} noValidate>
      <h2>Excluir empresa</h2>
      <p className="lead">
        Isso apaga <b>definitivamente</b> a empresa e todos os dados: vendas, custos, conexão com o Mercado Livre e usuários.
        Não há como desfazer.
      </p>
      {formError && <p className="banner banner-error" role="alert">{formError}</p>}
      <Field label="CNPJ da empresa" inputMode="numeric" placeholder="00.000.000/0000-00" value={cnpj} error={errors.cnpj} onValueChange={(v) => setCnpj(maskCnpj(v))} autoFocus />
      <Field label="Sua senha" type="password" revealable autoComplete="current-password" value={password} error={errors.password} onValueChange={setPassword} />
      <Button type="submit" loading={busy} className="btn-danger" disabled={!cnpj || !password}>
        Excluir definitivamente
      </Button>
      <button type="button" className="link" onClick={onCancel} style={{ justifySelf: 'center' }}>
        Cancelar
      </button>
    </form>
  );
}
