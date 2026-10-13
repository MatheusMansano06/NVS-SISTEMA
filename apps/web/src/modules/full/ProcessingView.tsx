import { useEffect, useState, type FormEvent } from 'react';
import type { WmsAgentStatusDto, WmsInboundResultDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { fileToBase64, fullApi } from './full-api';

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
      <AgentSetup />
    </div>
  );
}

/** Impressora Zebra: chave do agente (o mesmo ZebraAgent do NVS-WMS) e quem está conectado. */
function AgentSetup() {
  const [status, setStatus] = useState<WmsAgentStatusDto | null>(null);
  const [key, setKey] = useState('');
  const [error, setError] = useState('');
  const load = () => fullApi.agent().then(setStatus).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const site = window.location.origin;

  return (
    <section className="full-box full-tool">
      <header>
        <span className="full-tool-icon" aria-hidden="true">🖨️</span>
        <div>
          <h2>Impressora de etiquetas (Zebra)</h2>
          <p>
            As etiquetas saem sozinhas quando o operador termina de bipar um item. No computador com a Zebra roda o <b>ZebraAgent</b> — o mesmo
            do NVS-WMS — configurado com o endereço do sistema e a chave da empresa.
          </p>
        </div>
      </header>
      <div className="full-agents">
        {status?.connected.length ? (
          status.connected.map((a) => (
            <span key={a.machine} className="full-agent" data-on>
              ● {a.machine} · {a.printer ?? 'sem impressora'}{a.version ? ` · v${a.version}` : ''}
            </span>
          ))
        ) : (
          <span className="full-agent">○ Nenhum agente conectado agora</span>
        )}
      </div>
      {key ? (
        <div className="full-key">
          <p><b>Copie agora</b> — a chave não aparece de novo. No arquivo de configuração do agente:</p>
          <pre>{`BACKEND_URL=${site}/api\nMACHINE_ID=${key}.CAIXA1`}</pre>
          <p className="full-empty">Troque CAIXA1 pelo nome do computador (um por máquina). Gerar outra chave desliga as anteriores.</p>
        </div>
      ) : (
        <p className="full-empty">
          {status?.keys.length ? `Chave em uso: ${status.keys[0]!.hint}${status.keys[0]!.lastSeenAt ? ` · último contato ${new Date(status.keys[0]!.lastSeenAt).toLocaleString('pt-BR')}` : ''}.` : 'Nenhuma chave gerada ainda.'}
        </p>
      )}
      {error && <p className="banner banner-error">{error}</p>}
      <button
        type="button"
        className="act act-strong full-keybtn"
        onClick={async () => {
          if (status?.keys.length && !window.confirm('Gerar uma chave nova? Os agentes com a chave atual param de imprimir até receberem a nova.')) return;
          try {
            setKey((await fullApi.agentKey()).key);
            void load();
          } catch (err) {
            setError(err instanceof ApiError ? err.message : 'Não foi possível gerar.');
          }
        }}
      >
        {status?.keys.length ? 'Gerar nova chave' : 'Gerar chave do agente'}
      </button>
    </section>
  );
}
