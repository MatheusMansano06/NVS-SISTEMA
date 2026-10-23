import { useState, type ChangeEvent } from 'react';
import { costWithMarkup, csvRows, parseQuoteRows, type PricingStudyDto, type PricingSupplierDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { xlsxToCsv } from '../../shared/xlsx';
import { parse, toInput } from './num';
import { studiesApi } from './pricing-api';

interface Line { on: boolean; title: string; cost: string }

const base64 = (file: File) =>
  new Promise<string>((ok, fail) => {
    const r = new FileReader();
    r.onload = () => ok(String(r.result).replace(/^data:[^,]*,/, ''));
    r.onerror = () => fail(r.error);
    r.readAsDataURL(file);
  });

/** Cotação do fornecedor (Excel, CSV ou PDF) → confere/edita os itens → uma ficha por item, custo já com o % do fornecedor. */
export function QuoteImport({ supplier, taxPct, onDone }: { supplier: PricingSupplierDto; taxPct: number; onDone: (created: PricingStudyDto[]) => void }) {
  const [fileName, setFileName] = useState('');
  const [quoteRef, setQuoteRef] = useState('');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setFileName(file.name);
    setQuoteRef(file.name.replace(/\.[^.]+$/, ''));
    setLines(null);
    setError('');
    setBusy(true);
    try {
      const rows = /\.pdf$/i.test(file.name)
        ? (await studiesApi.quotePdf(await base64(file))).rows
        : csvRows(/\.xlsx$/i.test(file.name) ? await xlsxToCsv(await file.arrayBuffer()) : await file.text());
      const items = parseQuoteRows(rows);
      if (!items.length) setError('Não achei itens com preço nesse arquivo. Confira se é a cotação com nome do produto e valor.');
      setLines(items.map((i) => ({ on: true, title: i.title, cost: toInput(i.supplierCost) })));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível ler o arquivo. Use .xlsx, .csv ou o PDF original da cotação.');
    } finally {
      setBusy(false);
    }
  }

  const chosen = (lines ?? []).filter((l) => l.on && l.title.trim() && parse(l.cost) !== null);

  async function confirm() {
    setBusy(true);
    setError('');
    try {
      const created = await studiesApi.importQuote({
        supplierId: supplier.id,
        quoteRef: quoteRef.trim() || null,
        taxPct,
        packaging: 0.5,
        items: chosen.map((l) => ({ title: l.title.trim(), supplierCost: parse(l.cost)! })),
      });
      onDone(created);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível importar.');
      setBusy(false);
    }
  }

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls!.map((l, j) => (j === i ? { ...l, ...patch } : l)));

  return (
    <div className="pquote">
      <h2>Importar cotação · {supplier.name}</h2>
      <p className="lead">
        Envie a cotação do fornecedor em <b>Excel (.xlsx)</b>, <b>.csv</b> ou <b>PDF</b>. Cada item vira uma ficha na pasta, com o custo = preço da cotação
        {supplier.costMarkupPct ? <> + <b>{toInput(supplier.costMarkupPct).replace(/,00$/, '')}%</b></> : ' (sem acréscimo — ajuste o % da pasta se a cotação não traz IPI/ST)'}.
      </p>
      <label className="pquote-drop">
        <input type="file" accept=".xlsx,.csv,.pdf,text/csv,application/pdf,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e)} />
        <span>{busy && !lines ? 'Lendo…' : fileName || 'Escolher arquivo (.xlsx, .csv ou .pdf)'}</span>
        <small>Nada é gravado antes da sua confirmação.</small>
      </label>

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {lines && lines.length > 0 && (
        <>
          <label className="sku-input">
            <small>Nome da cotação (aparece em cada ficha)</small>
            <span className="sku-field"><input value={quoteRef} maxLength={200} onChange={(e) => setQuoteRef(e.target.value)} /></span>
          </label>
          <div className="pquote-table">
            <table>
              <thead>
                <tr><th><span className="sr-only">Importar</span></th><th>Produto</th><th>Preço na cotação</th><th>Custo na ficha</th></tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const c = parse(l.cost);
                  return (
                    <tr key={i} data-off={!l.on || undefined}>
                      <td><input type="checkbox" aria-label="Importar este item" checked={l.on} onChange={(e) => set(i, { on: e.target.checked })} /></td>
                      <td><input value={l.title} maxLength={200} onChange={(e) => set(i, { title: e.target.value })} /></td>
                      <td><input inputMode="decimal" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} /></td>
                      <td>{c === null ? '—' : money(costWithMarkup(c, supplier.costMarkupPct))}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <button type="button" className="btn btn-primary" disabled={busy || !chosen.length} onClick={() => void confirm()}>
            {busy ? 'Importando…' : `Criar ${chosen.length} ficha${chosen.length === 1 ? '' : 's'} em ${supplier.name}`}
          </button>
        </>
      )}
    </div>
  );
}
