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

/** Script do agente já configurado (Windows: CRLF e só ASCII). */
function startBat(site: string, key: string, machine: string) {
  return [
    '@echo off',
    'setlocal',
    'title NVS Zebra Agent - OPERACAO',
    'cd /d "%~dp0"',
    'rem Gerado pelo NVS Tech (Supervisao Full > Processamento). Nao compartilhe: contem a chave da empresa.',
    `set BACKEND_URL=${site}/api`,
    `set MACHINE_ID=${key}.${machine}`,
    'rem Opcional: nome exato da impressora (ex.: ZDesigner ZD421-203dpi ZPL)',
    'set PRINTER_NAME=',
    'set RECONNECT_BASE=2',
    'set RECONNECT_MAX=60',
    `echo  NVS Zebra Agent - maquina ${machine}`,
    'echo  Deixe esta janela aberta enquanto a operacao imprime etiquetas.',
    'if not exist ZebraAgent-WP.exe (',
    '  echo [ERRO] ZebraAgent-WP.exe nao esta nesta pasta. Baixe no NVS Tech e coloque junto deste arquivo.',
    '  pause',
    '  exit /b 1',
    ')',
    'ZebraAgent-WP.exe',
    'echo Agente encerrado.',
    'pause',
    'endlocal',
    '',
  ].join('\r\n');
}

/** Impressora Zebra: download do agente (o mesmo ZebraAgent do NVS-WMS), chave da empresa e quem está conectado. */
function AgentSetup() {
  const [status, setStatus] = useState<WmsAgentStatusDto | null>(null);
  const [key, setKey] = useState('');
  const [machine, setMachine] = useState('CAIXA1');
  const [error, setError] = useState('');
  const load = () => fullApi.agent().then(setStatus).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const site = window.location.origin;
  const cleanMachine = machine.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30) || 'CAIXA1';

  function downloadBat() {
    const blob = new Blob([startBat(site, key, cleanMachine)], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `iniciar_operacao_${cleanMachine}.bat`;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  async function generate() {
    if (status?.keys.length && !window.confirm('Gerar uma chave nova? Os computadores com a chave atual param de imprimir até receberem o .bat novo.')) return;
    setError('');
    try {
      setKey((await fullApi.agentKey()).key);
      void load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível gerar.');
    }
  }

  return (
    <section className="full-box full-tool">
      <header>
        <span className="full-tool-icon" aria-hidden="true">🖨️</span>
        <div>
          <h2>Impressora de etiquetas (Zebra)</h2>
          <p>
            As etiquetas saem sozinhas quando o operador termina de bipar um item. Para isso, o computador ligado na Zebra precisa estar com o{' '}
            <b>agente</b> aberto. Configure uma vez por computador:
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
      <ol className="full-steps">
        <li>
          <b>Baixe o agente</b> (Windows, não precisa instalar nada):{' '}
          <a className="act act-strong" href="/downloads/ZebraAgent-WP.exe" download>⬇ ZebraAgent-WP.exe</a>
          <small>Se o Windows avisar “aplicativo não reconhecido”, clique em “Mais informações” → “Executar assim mesmo”.</small>
        </li>
        <li>
          <b>Gere o arquivo de início deste computador</b> (já vem com o endereço do sistema e a chave da empresa):
          {key ? (
            <span className="full-inline full-machine">
              <input value={machine} maxLength={30} onChange={(e) => setMachine(e.target.value)} aria-label="Nome do computador" placeholder="Nome do computador" />
              <button type="button" className="act act-strong" onClick={downloadBat}>⬇ iniciar_operacao_{cleanMachine}.bat</button>
            </span>
          ) : (
            <button type="button" className="act act-strong" onClick={() => void generate()}>
              {status?.keys.length ? 'Gerar nova chave' : 'Gerar chave do agente'}
            </button>
          )}
          <small>
            {key
              ? 'Um nome diferente para cada computador (CAIXA1, CAIXA2…). Baixe um .bat por computador agora: a chave não aparece de novo.'
              : status?.keys.length
                ? `Já existe uma chave (${status.keys[0]!.hint}${status.keys[0]!.lastSeenAt ? `, último contato ${new Date(status.keys[0]!.lastSeenAt).toLocaleString('pt-BR')}` : ''}). Gerar outra desliga os computadores configurados com a anterior.`
                : 'A chave identifica a sua empresa: não compartilhe o .bat.'}
          </small>
        </li>
        <li>
          <b>Coloque os dois arquivos na mesma pasta</b> (ex.: <code>C:\NVS-ZebraAgent</code>) e dê dois cliques no <code>.bat</code>. Deixe a janela
          aberta: quando conectar, o computador aparece em verde aqui em cima.
        </li>
        <li>
          Impressão travou? Feche o agente e rode como administrador o{' '}
          <a className="link" href="/downloads/limpar_fila_impressao.bat" download>limpar_fila_impressao.bat</a>.
        </li>
      </ol>
      {error && <p className="banner banner-error">{error}</p>}
    </section>
  );
}
