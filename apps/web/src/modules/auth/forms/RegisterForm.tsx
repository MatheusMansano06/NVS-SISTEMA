import { useState, type FormEvent } from 'react';
import type { TeamMemberInput } from '@nvs/shared';
import { registerAccountSchema } from '@nvs/shared';
import { Button } from '../../../shared/ui/Button';
import { Field } from '../../../shared/ui/Field';
import { maskCnpj, maskPhone } from '../../../shared/masks';
import { authApi } from '../auth-api';
import { useForm } from '../useForm';
import { TeamRows, emptyMember, teamProblem } from '../../operation/TeamRows';
import '../../operation/operation.css';

export function RegisterForm({ onBack, onCreated }: { onBack: () => void; onCreated: (email: string) => void }) {
  const f = useForm({ email: '', phone: '', cnpj: '' });
  const [team, setTeam] = useState<TeamMemberInput[]>([emptyMember(true)]);
  const [teamError, setTeamError] = useState('');

  function submit(e: FormEvent) {
    e.preventDefault();
    const filled = team.filter((m) => m.name.trim()).map((m) => ({ ...m, name: m.name.trim() }));
    const problem = teamProblem(filled);
    setTeamError(problem ?? '');
    const data = f.validate(registerAccountSchema, { ...f.values, team: filled });
    if (!data || problem) return;
    void f.run(async () => {
      await authApi.register(data);
      onCreated(data.email);
    });
  }

  return (
    <form onSubmit={submit} noValidate aria-labelledby="register-title">
      <h2 id="register-title">Criar sua conta</h2>
      <p className="lead">Os dados da empresa e quem vai usar o sistema. Você define a senha da empresa no primeiro acesso.</p>

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
      <Field
        label="Telefone"
        type="tel"
        autoComplete="tel-national"
        inputMode="tel"
        placeholder="(11) 91234-5678"
        value={f.values.phone}
        error={f.errors.phone}
        onValueChange={(v) => f.set('phone')(maskPhone(v))}
      />
      <Field
        label="CNPJ"
        inputMode="numeric"
        autoComplete="off"
        placeholder="00.000.000/0000-00"
        value={f.values.cnpj}
        error={f.errors.cnpj}
        hint="O CNPJ será sua senha provisória."
        onValueChange={(v) => f.set('cnpj')(maskCnpj(v))}
      />

      <fieldset className="register-team">
        <legend>Sua equipe</legend>
        <p className="hint">
          Cada pessoa entra pelo nome + PIN de 4 números (começa com <b>1234</b>). Função: Análise, Operação ou as duas.
          O <b>MASTER</b> cadastra mais gente depois.
        </p>
        <TeamRows rows={team} onChange={setTeam} />
        {teamError && <p className="field-error" role="alert">{teamError}</p>}
      </fieldset>

      <Button type="submit" loading={f.busy}>
        {f.busy ? 'Criando…' : 'Criar conta'}
      </Button>

      <p className="switch">
        Já tem conta?{' '}
        <button type="button" className="link" onClick={onBack}>
          Entrar
        </button>
      </p>
    </form>
  );
}
