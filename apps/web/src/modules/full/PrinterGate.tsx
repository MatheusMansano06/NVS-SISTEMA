import { useCallback, useEffect, useState } from 'react';
import { WMS_LABEL_FORMAT_INFO, type WmsPrinterStatusDto } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { fullApi } from './full-api';
import { printPdf } from './print-pdf';

const hour = (iso: string) => new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

/** Separar está liberado? (sem Full em andamento, ou impressora conferida hoje) */
export const printerBlocks = (s: WmsPrinterStatusDto | null) => Boolean(s && s.fullRunning && !s.checkedToday);

/** Situação da impressora no topo da tela do operador (atualiza a cada 30 s). */
export function usePrinterStatus() {
  const [status, setStatus] = useState<WmsPrinterStatusDto | null>(null);
  const load = useCallback(() => fullApi.printer().then(setStatus).catch(() => undefined), []);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => window.clearInterval(t);
  }, [load]);
  return { status, reload: load };
}

/**
 * Conferência da impressora: as etiquetas saem em PDF (qualquer impressora, sem agente nem ERP). No 1º uso do dia com
 * Full em andamento, alguém do turno imprime a etiqueta de teste no formato da empresa e confirma que saiu no tamanho
 * certo e com o código nítido. Vale para todos que entrarem no computador naquele dia.
 */
export function PrinterGate({ status, reload }: { status: WmsPrinterStatusDto | null; reload: () => Promise<unknown> }) {
  const [busy, setBusy] = useState(false);
  const [printed, setPrinted] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false);
  if (!status) return null;
  const s = status.settings;
  const format = `${WMS_LABEL_FORMAT_INFO[s.labelFormat].label} · ${s.labelWidthMm} × ${s.labelHeightMm} mm`;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível falar com o servidor.');
    } finally {
      setBusy(false);
    }
  }

  if (status.checkedToday || !status.fullRunning) {
    const c = status.checkedToday;
    return (
      <section className="pgate" data-tone="ok">
        <span className="pgate-dot" aria-hidden="true" />
        <div className="pgate-body pgate-row">
          <b>{c ? 'Impressora pronta' : 'Impressão pelo navegador'}</b>
          <span>{format}</span>
          <small>{c ? `Conferida hoje por ${c.by} às ${hour(c.at)}` : 'A conferência do dia é pedida quando houver lista do Full para separar.'}</small>
        </div>
      </section>
    );
  }

  return (
    <section className="pgate" data-tone="check" aria-live="polite">
      <span className="pgate-dot" aria-hidden="true" />
      <div className="pgate-body">
        <b>Conferência da impressora de hoje</b>
        <p>
          As etiquetas saem em PDF no formato <b>{format}</b>, em qualquer impressora. Antes de começar o Full, imprima uma etiqueta de
          teste e confira o tamanho e o código de barras. Basta uma pessoa por dia.
        </p>
        <ol className="pgate-steps">
          <li data-done={printed || undefined}>
            <span>1. Imprimir a etiqueta de teste</span>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy}
              onClick={() => void run(async () => {
                await printPdf(fullApi.testPdfUrl());
                setPrinted(true);
              })}
            >
              {printed ? 'Imprimir de novo' : 'Imprimir teste'}
            </button>
            <small>Na janela de impressão: escolha a impressora de etiquetas, Escala 100% (tamanho real) e Margens: nenhuma.</small>
          </li>
          <li>
            <span>2. Saiu no tamanho da etiqueta e o código de barras está nítido?</span>
            <span className="pgate-actions">
              <button type="button" className="btn btn-primary btn-sm" disabled={busy || !printed} onClick={() => void run(async () => {
                await fullApi.printerConfirm();
                await reload();
              })}>
                Sim, liberar o dia
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setHelp((v) => !v)}>Não saiu certo</button>
            </span>
          </li>
        </ol>
        {help && (
          <ul className="pgate-help">
            <li>Saiu pequena, cortada ou em várias etiquetas? Na janela de impressão use Escala 100% / “Tamanho real” e Margens: nenhuma.</li>
            <li>Impressora térmica: nas preferências do driver (Elgin, Argox, Zebra…), o tamanho do papel tem que ser o da etiqueta ({format}).</li>
            <li>A medida da etiqueta está diferente? A Análise ajusta em Supervisão Full → Processamento → Impressão das etiquetas.</li>
            <li>Saiu em branco: confira se a etiqueta é térmica (o lado brilhante para fora) ou se falta ribbon na impressora.</li>
          </ul>
        )}
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        <p className="pgate-lock">🔒 A separação fica bloqueada até a conferência.</p>
      </div>
    </section>
  );
}
