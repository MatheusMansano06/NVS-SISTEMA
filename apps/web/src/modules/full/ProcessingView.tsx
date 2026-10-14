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
function startBat(site: string, key: string, machine: string, printer: string) {
  return [
    '@echo off',
    'setlocal',
    'title NVS Zebra Agent - OPERACAO',
    'cd /d "%~dp0"',
    'rem Gerado pelo NVS Tech (Supervisao Full > Processamento). Nao compartilhe: contem a chave da empresa.',
    `set BACKEND_URL=${site}/api`,
    `set MACHINE_ID=${key}.${machine}`,
    'rem Nome exato da impressora como aparece no Windows. Vazio = procura uma Zebra (Zebra/ZD/ZDesigner).',
    'rem Outras marcas (Elgin, Argox, TSC, Honeywell...) precisam do nome aqui e de aceitar ZPL.',
    `set PRINTER_NAME=${printer}`,
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

/**
 * Instalador de um clique (Windows): baixa o agente para %LOCALAPPDATA%\NVS-Agente, grava a configuração, registra o
 * endereço nvs-agente:// (o botão "Iniciar o agente" da Operação abre por ele), cria o atalho na área de trabalho e liga.
 * O mesmo arquivo, copiado para a pasta, é o lançador: não abre uma segunda cópia se o agente já estiver rodando.
 */
function installBat(site: string, key: string, machine: string, printer: string) {
  return [
    '@echo off',
    'setlocal',
    'rem Gerado pelo NVS Tech (Supervisao Full > Processamento). Nao compartilhe: contem a chave da empresa.',
    'set "DIR=%LOCALAPPDATA%\\NVS-Agente"',
    `set "SITE=${site}"`,
    'set "BACKEND_URL=%SITE%/api"',
    `set "MACHINE_ID=${key}.${machine}"`,
    'rem Nome exato da impressora no Windows. Vazio = procura uma Zebra (Zebra/ZD/ZDesigner). Outras marcas precisam aceitar ZPL.',
    `set "PRINTER_NAME=${printer}"`,
    'set RECONNECT_BASE=2',
    'set RECONNECT_MAX=60',
    'if /I "%~dp0"=="%DIR%\\" goto run',
    '',
    'echo Instalando o agente de impressao NVS em %DIR% ...',
    'if not exist "%DIR%" mkdir "%DIR%"',
    'copy /Y "%~f0" "%DIR%\\agente.bat" >nul',
    'if not exist "%DIR%\\ZebraAgent-WP.exe" (',
    '  echo Baixando o agente...',
    `  powershell -NoProfile -Command "$ProgressPreference='SilentlyContinue'; Invoke-WebRequest -UseBasicParsing -Uri '%SITE%/downloads/ZebraAgent-WP.exe' -OutFile '%DIR%\\ZebraAgent-WP.exe'"`,
    ')',
    'if not exist "%DIR%\\ZebraAgent-WP.exe" (',
    '  echo [ERRO] Nao foi possivel baixar o agente. Confira a internet e rode este arquivo de novo.',
    '  pause',
    '  exit /b 1',
    ')',
    'reg add "HKCU\\Software\\Classes\\nvs-agente" /ve /d "URL:Agente NVS" /f >nul',
    'reg add "HKCU\\Software\\Classes\\nvs-agente" /v "URL Protocol" /d "" /f >nul',
    'reg add "HKCU\\Software\\Classes\\nvs-agente\\shell\\open\\command" /ve /d "\\"%DIR%\\agente.bat\\" \\"%%1\\"" /f >nul',
    `powershell -NoProfile -Command "$s=(New-Object -ComObject WScript.Shell).CreateShortcut([Environment]::GetFolderPath('Desktop')+'\\Agente NVS.lnk'); $s.TargetPath='%DIR%\\agente.bat'; $s.WorkingDirectory='%DIR%'; $s.Save()"`,
    'echo.',
    'echo Pronto! Daqui para frente o agente abre pelo botao "Iniciar o agente" na tela da Operacao',
    'echo ou pelo icone "Agente NVS" na area de trabalho.',
    'echo.',
    '',
    ':run',
    'cd /d "%DIR%"',
    'tasklist /FI "IMAGENAME eq ZebraAgent-WP.exe" 2>nul | find /I "ZebraAgent-WP.exe" >nul',
    'if not errorlevel 1 (',
    '  echo O agente ja esta rodando neste computador.',
    '  timeout /t 4 >nul',
    '  exit /b 0',
    ')',
    `title Agente de impressao NVS - ${machine}`,
    `echo  Agente de impressao NVS - maquina ${machine}`,
    'echo  Deixe esta janela aberta enquanto a operacao imprime etiquetas.',
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
  const [printerName, setPrinterName] = useState('');
  const [error, setError] = useState('');
  const load = () => fullApi.agent().then(setStatus).catch(() => undefined);
  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), 15_000);
    return () => window.clearInterval(t);
  }, []);
  const site = window.location.origin;
  const cleanMachine = machine.toUpperCase().replace(/[^A-Z0-9_-]/g, '').slice(0, 30) || 'CAIXA1';
  // só ASCII seguro para o .bat (sem & | < > % ^ ")
  const cleanPrinter = printerName.replace(/[^\w .()\-/]/g, '').slice(0, 80).trim();

  function save(name: string, text: string) {
    const blob = new Blob([text], { type: 'application/octet-stream' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    window.setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  const downloadBat = () => save(`iniciar_operacao_${cleanMachine}.bat`, startBat(site, key, cleanMachine, cleanPrinter));
  const downloadInstaller = () => save(`instalar_agente_${cleanMachine}.bat`, installBat(site, key, cleanMachine, cleanPrinter));

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
          <h2>Impressora de etiquetas</h2>
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
          <b>Gere o instalador deste computador</b> (Windows; já vem com o endereço do sistema e a chave da empresa):
          {key ? (
            <span className="full-inline full-machine">
              <input value={machine} maxLength={30} onChange={(e) => setMachine(e.target.value)} aria-label="Nome do computador" placeholder="Nome do computador" />
              <input
                value={printerName}
                maxLength={80}
                onChange={(e) => setPrinterName(e.target.value)}
                aria-label="Nome da impressora no Windows"
                placeholder="Impressora (vazio = Zebra)"
              />
              <button type="button" className="act act-strong" onClick={downloadInstaller}>⬇ instalar_agente_{cleanMachine}.bat</button>
            </span>
          ) : (
            <button type="button" className="act act-strong" onClick={() => void generate()}>
              {status?.keys.length ? 'Gerar nova chave' : 'Gerar chave do agente'}
            </button>
          )}
          <small>
            {key
              ? 'Um nome diferente para cada computador (CAIXA1, CAIXA2…). Impressora de outra marca: escreva o nome exato como aparece em Configurações → Impressoras do Windows (ela precisa aceitar ZPL). Baixe um instalador por computador agora: a chave não aparece de novo.'
              : status?.keys.length
                ? `Já existe uma chave (${status.keys[0]!.hint}${status.keys[0]!.lastSeenAt ? `, último contato ${new Date(status.keys[0]!.lastSeenAt).toLocaleString('pt-BR')}` : ''}). Gerar outra desliga os computadores configurados com a anterior.`
                : 'A chave identifica a sua empresa: não compartilhe o instalador.'}
          </small>
        </li>
        <li>
          <b>No computador da impressora, dê dois cliques no instalador.</b> Ele baixa o agente, cria o ícone <b>Agente NVS</b> na área de trabalho e
          já liga. Se o Windows avisar “aplicativo não reconhecido”, clique em “Mais informações” → “Executar assim mesmo”.
          <small>
            Daí em diante, o operador liga o agente pelo botão <b>“▶ Iniciar o agente”</b> da tela da Operação (o navegador pergunta uma vez se pode
            abrir: marque “sempre permitir”) ou pelo ícone. Quando conectar, o computador aparece em verde aqui em cima.
          </small>
        </li>
        <li>
          Impressão travou? Feche o agente e rode como administrador o{' '}
          <a className="link" href="/downloads/limpar_fila_impressao.bat" download>limpar_fila_impressao.bat</a>.
          {key && (
            <small>
              Prefere instalar à mão? Baixe o <a className="link" href="/downloads/ZebraAgent-WP.exe" download>ZebraAgent-WP.exe</a> e o{' '}
              <button type="button" className="link" onClick={downloadBat}>iniciar_operacao_{cleanMachine}.bat</button> e coloque os dois na mesma pasta.
            </small>
          )}
        </li>
      </ol>
      {error && <p className="banner banner-error">{error}</p>}
    </section>
  );
}
