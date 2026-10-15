import { useEffect, useState, type FormEvent } from 'react';
import {
  WMS_LABEL_FORMATS,
  WMS_LABEL_FORMAT_INFO,
  type WmsInboundResultDto,
  type WmsLabelFormat,
  type WmsSettingsDto,
} from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { fileToBase64, fullApi, loadPrintSettings } from './full-api';
import { printPdf } from './print-pdf';

const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 10);

/** Processamento (só Análise): o PDF do envio Full vira lote + listas para a Operação. */
export function ProcessingView({ onDone }: { onDone: (batchId: string, marketplace: 'ml' | 'shopee') => void }) {
  const [date, setDate] = useState(today());
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [archive, setArchive] = useState<WmsInboundResultDto['oldest'] | null>(null);
  const [result, setResult] = useState<WmsInboundResultDto | null>(null);

  async function send(archiveOldestId?: string) {
    if (!file) return;
    setBusy(true);
    setError('');
    setResult(null);
    try {
      if (file.size > 10_000_000) throw new ApiError('O PDF passa de 10 MB.', 400, 'TOO_BIG');
      const r = await fullApi.inbound({ fullDate: date, pdfBase64: await fileToBase64(file), archiveOldestId });
      if (r.status === 'needs_archive') {
        setArchive(r.oldest ?? null);
        return;
      }
      setArchive(null);
      setResult(r);
      setFile(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível processar o PDF.');
    } finally {
      setBusy(false);
    }
  }

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void send();
  };

  return (
    <div className="full-proc">
      <section className="full-box full-tool">
        <header>
          <span className="full-tool-icon" aria-hidden="true">⬆️</span>
          <div>
            <h2>Carga do envio Full</h2>
            <p>
              Envie o PDF do envio Full: do <b>Mercado Livre</b> (“Lista de produtos e instruções de preparação”) ou da <b>Shopee</b>
              (“Shopee Picking List”). O sistema reconhece sozinho de onde é, lê SKU, código, EAN e quantidades, divide em listas de até
              1.000 unidades e libera para a Operação.
            </p>
          </div>
        </header>
        {archive && (
          <div className="banner banner-warn full-archive" role="alert">
            Já há 10 lotes ativos. O mais antigo, <b>{archive.name}</b>, ainda tem {archive.pending} item(ns) pendente(s). Arquivar ele para
            carregar este?
            <span>
              <button type="button" className="act" onClick={() => setArchive(null)}>Cancelar</button>
              <button type="button" className="act act-danger" onClick={() => void send(archive.id)}>Arquivar e carregar</button>
            </span>
          </div>
        )}
        <form className="full-form" onSubmit={submit}>
          <label>
            <small>Data do envio (coleta no Full)</small>
            <input type="date" required value={date} onChange={(e) => setDate(e.target.value)} />
          </label>
          <label className="full-file" data-has={file ? true : undefined}>
            <small>PDF do envio</small>
            <input type="file" accept="application/pdf,.pdf" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
            <span>{file ? `📄 ${file.name}` : 'Escolher o PDF…'}</span>
          </label>
          <Button type="submit" loading={busy} disabled={!file}>{busy ? 'Lendo o PDF…' : 'Processar carga'}</Button>
        </form>
        {error && <p className="banner banner-error" role="alert">{error}</p>}
        {result?.batch && (
          <div className="banner banner-ok full-result" role="status">
            Lote <b>{result.batch.name}</b> ({result.batch.marketplace === 'shopee' ? 'Shopee' : 'Mercado Livre'}) criado: {result.batch.lists.length} lista(s), {result.batch.lists.reduce((s, l) => s + l.skuCount, 0)} SKUs,{' '}
            {int(result.units ?? 0)} unidades.
            {result.declaredUnits != null && result.declaredUnits !== result.units && (
              <b> Atenção: o PDF diz {int(result.declaredUnits)} unidades e foram lidas {int(result.units ?? 0)}. Confira as listas.</b>
            )}
            <button type="button" className="act act-strong" onClick={() => onDone(result.batch!.id, result.batch!.marketplace)}>Ver o lote →</button>
          </div>
        )}
      </section>
      <PrintSetup />
    </div>
  );
}

/** Desenho do formato (rolo de 1 ou 2 colunas, folha A4) para escolher sem precisar ler. */
function FormatSketch({ format }: { format: WmsLabelFormat }) {
  const n = format === 'rolo_1col' ? 1 : format === 'rolo_2col' ? 2 : 9;
  return (
    <span className="full-fmt-sketch" data-format={format} aria-hidden="true">
      {Array.from({ length: n }, (_, i) => (
        <i key={i}>
          <b />
        </i>
      ))}
    </span>
  );
}

/**
 * Impressão das etiquetas (Análise): PDF no tamanho da etiqueta, impresso pelo navegador em qualquer impressora
 * (rolo de 1 ou 2 colunas ou folha A4, com a medida ajustável). Sem agente nem ERP.
 */
function PrintSetup() {
  const [saved, setSaved] = useState<WmsSettingsDto | null>(null);
  const [form, setForm] = useState<WmsSettingsDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  useEffect(() => {
    void loadPrintSettings(true)
      .then((s) => {
        setSaved(s);
        setForm(s);
      })
      .catch(() => setMsg({ tone: 'error', text: 'Não foi possível carregar a configuração de impressão.' }));
  }, []);
  if (!form) return msg ? <p className="banner banner-error">{msg.text}</p> : null;

  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const set = (patch: Partial<WmsSettingsDto>) => {
    setMsg(null);
    setForm({ ...form, ...patch });
  };
  const pickFormat = (f: WmsLabelFormat) =>
    set({ labelFormat: f, labelWidthMm: WMS_LABEL_FORMAT_INFO[f].widthMm, labelHeightMm: WMS_LABEL_FORMAT_INFO[f].heightMm });

  async function run(fn: () => Promise<unknown>, ok?: string) {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      if (ok) setMsg({ tone: 'ok', text: ok });
    } catch (err) {
      setMsg({ tone: 'error', text: err instanceof ApiError ? err.message : 'Não foi possível concluir.' });
    } finally {
      setBusy(false);
    }
  }
  const save = () =>
    run(async () => {
      const s = await fullApi.saveSettings(form);
      await loadPrintSettings(true);
      setSaved(s);
      setForm(s);
    }, 'Configuração salva. Vale para todos os computadores da empresa.');

  return (
    <>
      <section className="full-box full-tool">
        <header>
          <span className="full-tool-icon" aria-hidden="true">🖨️</span>
          <div>
            <h2>Impressão das etiquetas</h2>
            <p>
              As etiquetas saem em PDF no tamanho certo e imprimem em <b>qualquer impressora</b>: térmica (Elgin, Argox, Zebra…) ou comum com
              folha de etiquetas. Não precisa instalar nada. Escolha a etiqueta que vocês usam; vale para todos os computadores da empresa.
            </p>
          </div>
        </header>

        <h3 className="full-sub">Qual etiqueta vocês usam?</h3>
        <div className="full-fmt-row" role="radiogroup" aria-label="Formato da etiqueta">
          {WMS_LABEL_FORMATS.map((f) => (
            <button key={f} type="button" role="radio" aria-checked={form.labelFormat === f} className="full-choice-card full-fmt" onClick={() => pickFormat(f)}>
              <FormatSketch format={f} />
              <b>{WMS_LABEL_FORMAT_INFO[f].label}</b>
              <small>{WMS_LABEL_FORMAT_INFO[f].text}</small>
            </button>
          ))}
        </div>
        <div className="full-inline full-fmt-size">
          <label>
            <small>Largura de cada etiqueta (mm)</small>
            <input type="number" min={20} max={120} step={0.5} value={form.labelWidthMm} onChange={(e) => set({ labelWidthMm: Number(e.target.value) })} />
          </label>
          <span aria-hidden="true">×</span>
          <label>
            <small>Altura (mm)</small>
            <input type="number" min={15} max={80} step={0.5} value={form.labelHeightMm} onChange={(e) => set({ labelHeightMm: Number(e.target.value) })} />
          </label>
          <small>
            {form.labelFormat === 'rolo_2col'
              ? `Meça uma etiqueta só (o rolo tem ${form.labelWidthMm * 2} mm somando as duas colunas).`
              : form.labelFormat === 'a4'
                ? 'As etiquetas são centralizadas na folha A4.'
                : 'A medida está escrita na caixa do rolo (ex.: 50 × 25).'}
          </small>
        </div>

        <div className="full-inline">
          <Button type="button" loading={busy} disabled={!dirty} onClick={() => void save()}>Salvar</Button>
          <button type="button" className="act" disabled={busy || dirty} title={dirty ? 'Salve antes de testar' : undefined} onClick={() => void run(() => printPdf(fullApi.testPdfUrl()))}>
            🖨 Imprimir etiqueta de teste
          </button>
        </div>
        <p className="full-note">
          Na janela de impressão: escolha a impressora de etiquetas, <b>Escala 100%</b> (tamanho real) e <b>Margens: nenhuma</b>. Impressora
          térmica: deixe o tamanho do papel no driver igual ao da etiqueta.
        </p>
        {msg && <p className={`banner ${msg.tone === 'ok' ? 'banner-ok' : 'banner-error'}`} role={msg.tone === 'error' ? 'alert' : 'status'}>{msg.text}</p>}
      </section>
    </>
  );
}
