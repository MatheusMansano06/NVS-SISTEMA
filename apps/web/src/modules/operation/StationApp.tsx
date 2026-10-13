import { useCallback, useEffect, useState } from 'react';
import type { OperatorSessionDto, StationDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { PinPad } from './PinPad';
import { operationApi } from './operation-api';
import './operation.css';

type Stage = { kind: 'pick' } | { kind: 'pin'; id: string; name: string } | { kind: 'new-pin'; current: string } | { kind: 'home' };

/** Computador da operação: escolhe o nome, digita o PIN e entra. A Análise não abre daqui. */
export function StationApp({ initial }: { initial: StationDto }) {
  const [station, setStation] = useState(initial);
  const [stage, setStage] = useState<Stage>({ kind: 'pick' });
  const [session, setSession] = useState<OperatorSessionDto | null>(null);
  const [pin, setPin] = useState('');
  const [first, setFirst] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  // já havia um operador logado neste computador?
  useEffect(() => {
    operationApi
      .me()
      .then((s) => {
        setSession(s);
        setStage(s.operator.mustChangePin ? { kind: 'new-pin', current: '' } : { kind: 'home' });
      })
      .catch(() => undefined);
  }, []);

  const backToPick = useCallback(async () => {
    await operationApi.logout().catch(() => undefined);
    setSession(null);
    setPin('');
    setFirst('');
    setError('');
    setStage({ kind: 'pick' });
    setStation(await operationApi.station().catch(() => station));
  }, [station]);

  async function login(id: string, value: string) {
    setBusy(true);
    setError('');
    try {
      const s = await operationApi.login(id, value);
      setSession(s);
      setPin('');
      setStage(s.operator.mustChangePin ? { kind: 'new-pin', current: value } : { kind: 'home' });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível entrar.');
      setPin('');
    } finally {
      setBusy(false);
    }
  }

  async function savePin(current: string, next: string) {
    setBusy(true);
    setError('');
    try {
      setSession(await operationApi.changePin(current, next));
      setStage({ kind: 'home' });
    } catch (err) {
      setError(err instanceof ApiError ? Object.values(err.fieldErrors).flat()[0] ?? err.message : 'Não foi possível salvar.');
      setFirst('');
    } finally {
      setPin('');
      setBusy(false);
    }
  }

  return (
    <div className="station">
      <header className="station-top">
        <img src="/nvs-logo.webp" alt="NVS Tech" height="40" />
        <span className="station-tag">Operação · {station.tenant.name}</span>
        {session && stage.kind === 'home' ? (
          <span className="station-user">
            <b>{session.operator.name}</b>
            <button type="button" className="act" onClick={() => setStage({ kind: 'new-pin', current: '' })}>Trocar PIN</button>
            <button type="button" className="act" onClick={() => void backToPick()}>Sair</button>
          </span>
        ) : (
          <button
            type="button"
            className="link station-exit"
            onClick={async () => {
              if (!window.confirm('Sair do modo Operação neste computador? Para entrar de novo será preciso o e-mail e a senha da empresa.')) return;
              await operationApi.exitStation().catch(() => undefined);
              window.location.href = '/';
            }}
          >
            Sair do modo Operação
          </button>
        )}
      </header>

      <main className="station-main">
        {stage.kind === 'pick' && (
          <section className="station-pick">
            <h1>Quem vai usar agora?</h1>
            <p>Toque no seu nome.</p>
            {!station.operators.length && <p className="banner banner-error">Nenhum operador cadastrado. Peça para quem é da Análise cadastrar em “Operadores”.</p>}
            <ul>
              {station.operators.map((o) => (
                <li key={o.id}>
                  <button type="button" onClick={() => { setError(''); setPin(''); setStage({ kind: 'pin', id: o.id, name: o.name }); }}>
                    <span className="station-avatar" aria-hidden="true">{o.name.charAt(0).toUpperCase()}</span>
                    {o.name}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}

        {stage.kind === 'pin' && (
          <section className="station-pin">
            <button type="button" className="link" onClick={() => setStage({ kind: 'pick' })}>‹ Trocar operador</button>
            <h1>Olá, {stage.name}!</h1>
            <p>Digite seu PIN de 4 números. Primeiro acesso? É <b>1234</b>.</p>
            <PinPad value={pin} onChange={setPin} onComplete={(v) => void login(stage.id, v)} disabled={busy} error={Boolean(error)} />
            {error && <p className="banner banner-error" role="alert">{error}</p>}
          </section>
        )}

        {stage.kind === 'new-pin' && (
          <section className="station-pin">
            {stage.current === '' && !first && session && !session.operator.mustChangePin && (
              <button type="button" className="link" onClick={() => setStage({ kind: 'home' })}>‹ Voltar</button>
            )}
            <h1>{!first ? (session?.operator.mustChangePin ? 'Crie seu PIN' : 'Novo PIN') : 'Confirme o PIN'}</h1>
            <p>
              {session?.operator.mustChangePin
                ? 'Por segurança, troque o 1234 por um PIN só seu (4 números, sem repetir tudo igual).'
                : 'Escolha 4 números que só você saiba.'}
            </p>
            {stage.current === '' && !first ? (
              <CurrentPin onDone={(cur) => setStage({ kind: 'new-pin', current: cur })} />
            ) : (
              <PinPad
                value={pin}
                onChange={setPin}
                disabled={busy}
                error={Boolean(error)}
                onComplete={(v) => {
                  if (!first) {
                    setFirst(v);
                    setPin('');
                  } else if (v !== first) {
                    setError('Os PINs não conferem. Comece de novo.');
                    setFirst('');
                    setPin('');
                  } else {
                    void savePin(stage.current, v);
                  }
                }}
              />
            )}
            {error && <p className="banner banner-error" role="alert">{error}</p>}
          </section>
        )}

        {stage.kind === 'home' && session && <OperationHome name={session.operator.name} />}
      </main>
    </div>
  );
}

function CurrentPin({ onDone }: { onDone: (pin: string) => void }) {
  const [v, setV] = useState('');
  return (
    <>
      <p className="station-step">Primeiro, seu PIN atual:</p>
      <PinPad value={v} onChange={setV} onComplete={onDone} />
    </>
  );
}

const SOON = [
  { icon: '📦', title: 'Separação', text: 'Lista do que separar para envio, por coleta e Flex.' },
  { icon: '✅', title: 'Conferência', text: 'Bipe o produto para conferir antes de embalar.' },
  { icon: '🏷️', title: 'Etiquetas', text: 'Imprimir etiquetas de envio do dia.' },
  { icon: '🚚', title: 'Expedição', text: 'Fechar coletas e acompanhar o que saiu.' },
];

/** Início da Operação: as funções da expedição entram aqui (todos os operadores veem o mesmo). */
function OperationHome({ name }: { name: string }) {
  return (
    <section className="station-home">
      <h1>Bom trabalho, {name}! 👋</h1>
      <p>Estas são as funções da expedição. Elas vão sendo liberadas aqui.</p>
      <div className="station-cards">
        {SOON.map((c) => (
          <article key={c.title} aria-disabled="true">
            <span aria-hidden="true">{c.icon}</span>
            <strong>{c.title}</strong>
            <p>{c.text}</p>
            <small>em breve</small>
          </article>
        ))}
      </div>
    </section>
  );
}
