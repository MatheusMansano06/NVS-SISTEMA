import { useEffect, useRef, useState } from 'react';
import { SYNC_PHASES, SYNC_PHASE_END, SYNC_PHASE_LABELS, type MlConnectionDto, type MlStatusDto } from '@nvs/shared';
import { Button } from '../../shared/ui/Button';
import { goToMercadoLivre, mlApi } from './ml-api';
import './sync.css';

const POLL_RUNNING_MS = 2500; // sincronizando: acompanha de perto
const POLL_IDLE_MS = 60_000; // parado: só para refletir os ciclos de hora em hora

/**
 * "Preenchendo seu sistema": acompanha a sincronização progressiva do Mercado Livre
 * e avisa o dashboard a cada avanço para ele se atualizar sozinho.
 */
export function SyncProgress({ onAdvance, justConnected }: { onAdvance: () => void; justConnected: boolean }) {
  const [status, setStatus] = useState<MlStatusDto | null>(null);
  const [error, setError] = useState('');
  // muda a cada "Sincronizar agora": reinicia o acompanhamento
  const [pollKey, setPollKey] = useState(0);
  const lastProgress = useRef<string>('');

  useEffect(() => {
    let alive = true;
    let timer = 0;
    const tick = async () => {
      try {
        const s = await mlApi.status();
        if (!alive) return;
        setStatus(s);
        const signature = s.connections.map((c) => `${c.sync?.status}:${c.sync?.progress}:${c.history?.monthsDone}`).join('|');
        if (lastProgress.current && signature !== lastProgress.current) onAdvance();
        lastProgress.current = signature;
        const running = s.connections.some((c) => c.sync?.status === 'running' || c.history?.running);
        const waiting = justConnected && !s.connections.length;
        timer = window.setTimeout(tick, running || waiting ? POLL_RUNNING_MS : POLL_IDLE_MS);
      } catch {
        if (alive) timer = window.setTimeout(tick, POLL_RUNNING_MS * 2);
      }
    };
    void tick();
    return () => {
      alive = false;
      window.clearTimeout(timer);
    };
  }, [onAdvance, justConnected, pollKey]);

  async function retry(c: MlConnectionDto) {
    setError('');
    try {
      await mlApi.sync(c.id);
      lastProgress.current = '';
      setPollKey((k) => k + 1); // religa o acompanhamento de perto
    } catch {
      setError('Não foi possível iniciar a sincronização.');
    }
  }

  async function connect() {
    setError('');
    try {
      await goToMercadoLivre();
    } catch {
      setError('Não foi possível abrir o Mercado Livre. Tente novamente.');
    }
  }

  if (!status?.configured) return null;

  if (!status.connections.length) {
    return (
      <section className="sync sync-cta" aria-label="Conectar Mercado Livre">
        <img src="/gertrudez.webp" alt="" className="sync-avatar" />
        <div>
          <strong>Conecte sua conta do Mercado Livre</strong>
          <p>Eu trago suas vendas e vou preenchendo o sistema por etapas. Leva poucos minutos.</p>
        </div>
        <Button onClick={() => void connect()}>Conectar Mercado Livre</Button>
        {error && <p className="sync-error" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <>
      {status.connections.map((c) => {
        const run = c.sync;
        if (c.status !== 'active') {
          return (
            <section key={c.id} className="sync sync-warn" role="alert">
              <img src="/gertrudez.webp" alt="" className="sync-avatar" />
              <div>
                <strong>A conexão com {c.nickname} precisa ser renovada</strong>
                <p>{c.lastError ?? 'O Mercado Livre não aceitou mais a autorização.'}</p>
              </div>
              <Button onClick={() => void connect()}>Reconectar</Button>
            </section>
          );
        }
        if (!run || run.status === 'done') {
          return (
            <section key={c.id} className="sync sync-done" aria-label="Mercado Livre conectado">
              <span className="sync-dot" aria-hidden="true" />
              <p>
                <strong>{c.nickname}</strong> conectada
                {c.lastSyncedAt &&
                  ` · números atualizados às ${new Date(c.lastSyncedAt).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' })}`}
                <small> · atualização automática a cada hora; vendas novas entram na hora</small>
                {c.history && c.history.monthsDone < c.history.monthsTotal && (
                  <small className="sync-history">
                    {' · '}
                    {c.history.running ? 'Guardando o histórico de vendas' : 'Histórico de vendas'}: {c.history.monthsDone} de {c.history.monthsTotal} meses
                    {c.history.running ? ' (em segundo plano, pode usar o sistema)' : ''}
                  </small>
                )}
              </p>
              <button type="button" className="link" onClick={() => void retry(c)}>
                Sincronizar agora
              </button>
            </section>
          );
        }
        const current = SYNC_PHASES.indexOf(run.phase);
        return (
          <section key={c.id} className="sync sync-running" aria-live="polite" data-failed={run.status === 'failed' || undefined}>
            <img src="/gertrudez.webp" alt="" className="sync-avatar" />
            <div className="sync-body">
              <div className="sync-head">
                <strong>
                  {run.status === 'failed' ? 'A sincronização parou no meio do caminho' : `Preenchendo seu sistema com os dados de ${c.nickname}`}
                </strong>
                <span className="sync-pct">{run.progress}%</span>
              </div>
              <div className="sync-bar" role="progressbar" aria-valuenow={run.progress} aria-valuemin={0} aria-valuemax={100} aria-label="Progresso da sincronização">
                <span style={{ width: `${run.progress}%` }} />
              </div>
              <ol className="sync-steps">
                {SYNC_PHASES.map((p, i) => {
                  const state = run.progress >= SYNC_PHASE_END[p] ? 'done' : i === current ? 'current' : 'next';
                  return (
                    <li key={p} data-state={state}>
                      <span aria-hidden="true">{state === 'done' ? '✓' : i + 1}</span>
                      {SYNC_PHASE_LABELS[p]}
                    </li>
                  );
                })}
              </ol>
              <p className="sync-meta">
                {run.status === 'failed'
                  ? run.error
                  : run.phase === 'finishing'
                    ? 'Últimos ajustes: frete pago de cada envio e a fatura do ML. Pode levar alguns minutos — o sistema já pode ser usado.'
                    : `${run.ordersImported.toLocaleString('pt-BR')} pedidos importados até agora. O dashboard se atualiza sozinho.`}
              </p>
            </div>
            {run.status === 'failed' && <Button onClick={() => void retry(c)}>Tentar novamente</Button>}
          </section>
        );
      })}
      {error && <p className="sync-error" role="alert">{error}</p>}
    </>
  );
}
