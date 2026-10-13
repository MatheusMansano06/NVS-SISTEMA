import { useState, type FormEvent } from 'react';
import { TEAM_AREA_LABELS, type TeamDto, type TeamMemberInput } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { useAuth } from '../auth/AuthContext';
import { TeamRows, emptyMember, teamProblem } from './TeamRows';
import { teamApi } from './operation-api';
import './operation.css';

/** Conta sem MASTER: cadastra a equipe antes de entrar (contas criadas antes da equipe existir). */
export function TeamSetup({ team, onDone }: { team: TeamDto; onDone: () => void }) {
  const { logout } = useAuth();
  const [rows, setRows] = useState<TeamMemberInput[]>([emptyMember(true)]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const filled = rows.filter((r) => r.name.trim());
    const problem = teamProblem(filled);
    if (problem) return setError(problem);
    setBusy(true);
    setError('');
    try {
      await teamApi.setup(filled.map((r) => ({ ...r, name: r.name.trim() })));
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="station">
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">{team.tenant.name}</span>
        <button type="button" className="link station-exit" onClick={() => void logout()}>Sair</button>
      </header>
      <main className="station-main">
        <form className="team-setup" onSubmit={submit}>
          <h1>Cadastre sua equipe</h1>
          <p>
            Cada pessoa entra tocando no próprio nome e digitando um PIN de 4 números (começa com <b>1234</b>; troca se quiser).
            O <b>MASTER</b> cadastra e edita a equipe — pode ter mais de um.
          </p>
          {team.members.length > 0 && (
            <p className="ledit-hint">
              Já cadastrados (continuam como estão): {team.members.map((m) => `${m.name} (${TEAM_AREA_LABELS[m.area]})`).join(', ')}.
            </p>
          )}
          <TeamRows rows={rows} onChange={setRows} />
          {error && <p className="banner banner-error" role="alert">{error}</p>}
          <Button type="submit" loading={busy}>Salvar e entrar</Button>
        </form>
      </main>
    </div>
  );
}
