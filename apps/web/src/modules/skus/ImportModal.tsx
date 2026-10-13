import { useState, type ChangeEvent } from 'react';
import type { SkuImportReport } from '@nvs/shared';
import { Button } from '../../shared/ui/Button';
import { ApiError } from '../../shared/http';
import { skusApi } from './skus-api';
import { xlsxToCsv } from '../../shared/xlsx';

/** Importação em 2 passos (regra do NVS-WMS): pré-visualiza → confirma. Erro em qualquer linha = nada é gravado. */
export function ImportModal({ onDone }: { onDone: () => void }) {
  const [csv, setCsv] = useState('');
  const [fileName, setFileName] = useState('');
  const [report, setReport] = useState<SkuImportReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setReport(null);
    setError('');
    let text: string;
    try {
      text = /\.xlsx$/i.test(file.name) ? await xlsxToCsv(await file.arrayBuffer()) : await file.text();
    } catch {
      setError('Não foi possível ler o arquivo. Use .xlsx (Excel) ou .csv.');
      return;
    }
    setCsv(text);
    await run(text, true);
  }

  async function run(text: string, dryRun: boolean) {
    setBusy(true);
    setError('');
    try {
      const r = await skusApi.importCsv(text, dryRun);
      setReport(r);
      if (!dryRun && r.status === 'ok') onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível ler a planilha');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="import">
      <h2>Importar planilha</h2>
      <p className="lead">
        Envie a planilha do <b>Excel (.xlsx)</b> ou <b>.csv</b> com as colunas <code>SKU</code> e{' '}
        <code>Custo Unitario</code>. Coluna de imposto, se houver, é ignorada: o imposto é a alíquota única da empresa.
      </p>
      <label className="dropzone">
        <input type="file" accept=".xlsx,.csv,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e)} />
        <span>{fileName || 'Escolher planilha (.xlsx ou .csv)'}</span>
        <small>Nada é gravado antes da sua confirmação.</small>
      </label>

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {report && (
        <div className="import-report" data-status={report.status}>
          {report.status === 'rejected' ? (
            <>
              <strong>Planilha com {report.invalidRows.length} linha(s) inválida(s) — nada foi gravado.</strong>
              <ul>
                {report.invalidRows.map((r) => (
                  <li key={`${r.line}-${r.sku}`}>Linha {r.line}{r.sku ? ` (${r.sku})` : ''}: {r.reason}</li>
                ))}
              </ul>
            </>
          ) : (
            <>
              <strong>{report.status === 'ok' ? 'Importação concluída!' : 'Pré-visualização'}</strong>
              <div className="import-nums">
                <span><b>{report.created}</b> novos</span>
                <span><b>{report.updated}</b> alterados</span>
                <span><b>{report.unchanged}</b> sem mudança</span>
              </div>
              {report.status === 'dry_run' && (
                <Button onClick={() => void run(csv, false)} loading={busy} disabled={!report.created && !report.updated}>
                  Confirmar importação
                </Button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
