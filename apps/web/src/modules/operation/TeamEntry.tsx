import { useEffect, useState } from 'react';
import { areaAllows, type PersonSessionDto, type TeamDto, type TeamMode } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { useAuth } from '../auth/AuthContext';
import { PinPad } from './PinPad';
import { teamApi } from './operation-api';
import './operation.css';

type Stage = { kind: 'mode' } | { kind: 'pick'; mode: TeamMode } | { kind: 'pin'; mode: TeamMode; id: string; name: string };

/** Entrada: Análise ou Operação → toca no nome → PIN de 4 números. */
export function TeamEntry({ team, onEnter }: { team: TeamDto; onEnter: (p: PersonSessionDto) => void }) {
  const { logout } = useAuth();
  const [stage, setStage] = useState<Stage>({ kind: 'mode' });
  const [pin, setPin] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setPin('');
    setError('');
  }, [stage]);

  async function login(id: string, mode: TeamMode, value: string) {
    setBusy(true);
    setError('');
    try {
      onEnter(await teamApi.login(id, value, mode));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  const label = (m: TeamMode) => (m === 'analise' ? 'Análise' : 'Operação');
  return (
    <div className="station">
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">{stage.kind === 'mode' ? team.tenant.name : `${label(stage.mode)} · ${team.tenant.name}`}</span>
        <button type="button" className="link station-exit" onClick={() => void logout()}>Sair da conta da empresa</button>
      </header>
      <main className="station-main">
        {stage.kind === 'mode' && (
          <section className="mode-inner">
            <h1>Como você vai usar agora?</h1>
            <div className="mode-cards">
              <button type="button" className="mode-card" onClick={() => setStage({ kind: 'pick', mode: 'analise' })}>
                <span className="mode-icon" aria-hidden="true">📊</span>
                <strong>Análise</strong>
                <span>Dashboard, vendas, anúncios, precificador, finanças e frete.</span>
                <em>Entrar →</em>
              </button>
              <button type="button" className="mode-card mode-op" onClick={() => setStage({ kind: 'pick', mode: 'operacao' })}>
                <span className="mode-icon" aria-hidden="true">📦</span>
                <strong>Operação</strong>
                <span>Expedição: separação, conferência, etiquetas e coletas.</span>
                <em>Entrar →</em>
              </button>
            </div>
          </section>
        )}

        {stage.kind === 'pick' && (
          <section className="station-pick">
            <button type="button" className="link" onClick={() => setStage({ kind: 'mode' })}>‹ Voltar</button>
            <h1>Quem é você?</h1>
            <p>Toque no seu nome.</p>
            {(() => {
              const people = team.members.filter((m) => areaAllows(m.area, stage.mode));
              if (!people.length) return <p className="banner banner-error">Ninguém cadastrado na {label(stage.mode)}. Peça a um MASTER para cadastrar.</p>;
              return (
                <ul>
                  {people.map((o) => (
                    <li key={o.id}>
                      <button type="button" onClick={() => setStage({ kind: 'pin', mode: stage.mode, id: o.id, name: o.name })}>
                        <span className="station-avatar" aria-hidden="true">{o.name.charAt(0).toUpperCase()}</span>
                        {o.name}
                      </button>
                    </li>
                  ))}
                </ul>
              );
            })()}
          </section>
        )}

        {stage.kind === 'pin' && (
          <section className="station-pin">
            <button type="button" className="link" onClick={() => setStage({ kind: 'pick', mode: stage.mode })}>‹ Não sou {stage.name}</button>
            <h1>Olá, {stage.name}!</h1>
            <p>Digite seu PIN de 4 números. Ainda não criou o seu? É <b>1234</b>.</p>
            <PinPad value={pin} onChange={setPin} onComplete={(v) => void login(stage.id, stage.mode, v)} disabled={busy} error={Boolean(error)} />
            {error && <p className="banner banner-error" role="alert">{error}</p>}
          </section>
        )}
      </main>
    </div>
  );
}
