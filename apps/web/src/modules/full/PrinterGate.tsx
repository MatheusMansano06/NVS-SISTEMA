import { useCallback, useEffect, useState } from 'react';
import type { WmsPrinterStatusDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { fullApi } from './full-api';

const hour = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
const TEST_STATE: Record<string, string> = {
  PENDING: 'Na fila: aguardando o agente pegar…',
  PRINTING: 'Imprimindo…',
  PRINTED: 'O agente avisou que imprimiu.',
  ERROR: 'O agente não conseguiu imprimir.',
};

/** Separar está liberado? (sem Full em andamento, ou impressora ligada e conferida hoje) */
export const printerBlocks = (s: WmsPrinterStatusDto | null) => Boolean(s && s.fullRunning && (!s.ready || !s.checkedToday));

/** Situação da impressora no topo da tela do operador (atualiza a cada 10 s). */
export function usePrinterStatus() {
  const [status, setStatus] = useState<WmsPrinterStatusDto | null>(null);
  const load = useCallback(() => fullApi.printer().then(setStatus).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 10_000);
    return () => window.clearInterval(t);
  }, [load]);
  return { status, reload: load };
}

/**
 * Conferência da impressora: o agente precisa estar ligado e, no 1º uso do dia com Full em andamento, alguém do turno
 * imprime a etiqueta de teste e confirma que saiu legível. Vale para todos que entrarem no computador naquele dia.
 */
export function PrinterGate({ status, reload }: { status: WmsPrinterStatusDto | null; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  if (!status) return null;
  const agent = status.agents.find((a) => a.printer && a.printer.toUpperCase() !== 'NENHUMA') ?? status.agents[0];

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível falar com o servidor.');
    } finally {
      setBusy(false);
    }
  }

  if (!status.ready) {
    return (
      <section className="pgate" data-tone="off" aria-live="polite">
        <span className="pgate-dot" aria-hidden="true" />
        <div className="pgate-body">
          <b>{status.agents.length ? 'O agente está ligado, mas não encontrou a impressora' : 'Impressora desligada: o agente não está rodando'}</b>
          <p>
            {status.agents.length
              ? `O computador ${status.agents[0]!.machine} está conectado, mas nenhuma impressora de etiquetas foi detectada. Confira se ela está ligada e no cabo, e reabra o agente.`
              : 'Neste computador, abra o arquivo iniciar_operacao (a janela preta do agente) e deixe-a aberta. Em alguns segundos esta faixa fica verde.'}
          </p>
          {status.fullRunning && <p className="pgate-lock">🔒 A separação fica bloqueada até a impressora estar pronta.</p>}
        </div>
      </section>
    );
  }

  if (status.checkedToday) {
    const c = status.checkedToday;
    return (
      <section className="pgate" data-tone="ok">
        <span className="pgate-dot" aria-hidden="true" />
        <div className="pgate-body pgate-row">
          <b>Impressora pronta</b>
          <span>{agent?.machine} · {agent?.printer}</span>
          <small>Conferida hoje por {c.by} às {hour(c.at)}</small>
        </div>
      </section>
    );
  }

  if (!status.fullRunning) {
    return (
      <section className="pgate" data-tone="ok">
        <span className="pgate-dot" aria-hidden="true" />
        <div className="pgate-body pgate-row">
          <b>Impressora ligada</b>
          <span>{agent?.machine} · {agent?.printer}</span>
          <small>A conferência do dia é pedida quando houver lista do Full para separar.</small>
        </div>
      </section>
    );
  }

  const test = status.lastTest && new Date(status.lastTest.at).toDateString() === new Date().toDateString() ? status.lastTest : null;
  return (
    <section className="pgate" data-tone="check" aria-live="polite">
      <span className="pgate-dot" aria-hidden="true" />
      <div className="pgate-body">
        <b>Conferência da impressora de hoje</b>
        <p>
          Agente ligado em <b>{agent?.machine}</b> ({agent?.printer}). Antes de começar o Full, imprima uma etiqueta de teste e confira se saiu
          legível. Basta uma pessoa por dia: vale para todos que entrarem neste computador.
        </p>
        <ol className="pgate-steps">
          <li data-done={test?.status === 'PRINTED' || undefined}>
            <span>1. Imprimir a etiqueta de teste</span>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy || test?.status === 'PENDING' || test?.status === 'PRINTING'} onClick={() => void run(fullApi.printerTest)}>
              {test ? 'Imprimir de novo' : 'Imprimir teste'}
            </button>
            {test && <small data-error={test.status === 'ERROR' || undefined}>{TEST_STATE[test.status]}{test.error ? ` (${test.error})` : ''}</small>}
          </li>
          <li>
            <span>2. A etiqueta saiu e o código de barras está nítido?</span>
            <span className="pgate-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || test?.status !== 'PRINTED'} onClick={() => void run(fullApi.printerConfirm)}>
                Sim, liberar o dia
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHelp((v) => !v)}>Não saiu</button>
            </span>
          </li>
        </ol>
        {help && (
          <ul className="pgate-help">
            <li>Confira se a impressora está ligada, com etiqueta e sem luz vermelha piscando.</li>
            <li>Na janela preta do agente, veja se aparece o nome da impressora certa. Se não, feche e abra de novo.</li>
            <li>Se a etiqueta saiu com letras estranhas ou em branco, a impressora pode não aceitar ZPL: chame o responsável.</li>
            <li>Travou na fila? Feche o agente, rode o limpar_fila_impressao como administrador e abra o agente de novo.</li>
          </ul>
        )}
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        <p className="pgate-lock">🔒 A separação fica bloqueada até a conferência.</p>
      </div>
    </section>
  );
}
