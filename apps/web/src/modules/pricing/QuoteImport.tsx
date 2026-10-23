import { useState, type ChangeEvent } from 'react';
import { costWithMarkup, csvRows, detectQuoteTaxPct, parseQuoteRows, type PricingStudyDto, type PricingSupplierDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Icon } from '../../shared/ui/Icon';
import { xlsToRows } from '../../shared/xls';
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

async function readRows(file: File): Promise<string[][]> {
  if (/\.pdf$/i.test(file.name)) return (await studiesApi.quotePdf(await base64(file))).rows;
  if (/\.xls$/i.test(file.name)) return xlsToRows(await file.arrayBuffer());
  if (/\.xlsx$/i.test(file.name)) return csvRows(await xlsxToCsv(await file.arrayBuffer()));
  return csvRows(await file.text());
}

const pctText = (n: number) => n.toLocaleString('pt-BR', { maximumFractionDigits: 2 });

/** Cotação do fornecedor (Excel, CSV ou PDF) → confere/edita os itens → uma ficha por item, custo já com o % do fornecedor. */
export function QuoteImport({ supplier, taxPct, onDone, onUsePct }: {
  supplier: PricingSupplierDto;
  taxPct: number;
  onDone: (created: PricingStudyDto[]) => void;
  onUsePct: (pct: number) => Promise<unknown>;
}) {
  const [fileName, setFileName] = useState('');
  const [quoteRef, setQuoteRef] = useState('');
  const [lines, setLines] = useState<Line[] | null>(null);
  const [tax, setTax] = useState<{ pct: number; ipi: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function onFile(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setFileName(file.name);
    setQuoteRef(file.name.replace(/\.[^.]+$/, ''));
    setLines(null);
    setTax(null);
    setError('');
    setBusy(true);
    try {
      const rows = await readRows(file);
      const items = parseQuoteRows(rows);
      if (!items.length) setError('Não achei itens com preço nesse arquivo. Confira se é a cotação com nome do produto e valor.');
      setLines(items.map((i) => ({ on: true, title: i.title, cost: toInput(i.supplierCost) })));
      setTax(detectQuoteTaxPct(rows));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível ler o arquivo. Use .xls, .xlsx, .csv ou o PDF original da cotação.');
    } finally {
      setBusy(false);
    }
  }

  const chosen = (lines ?? []).filter((l) => l.on && l.title.trim() && parse(l.cost) !== null);
  const pct = supplier.costMarkupPct;

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

  async function usePct(n: number) {
    setBusy(true);
    await onUsePct(n);
    setBusy(false);
  }

  const set = (i: number, patch: Partial<Line>) => setLines((ls) => ls!.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const allOn = !!lines?.length && lines.every((l) => l.on);

  return (
    <div className="pquote">
      <header className="pquote-head">
        <span className="pquote-icon"><Icon name="upload" size={20} /></span>
        <div>
          <h2>Importar cotação</h2>
          <p>
            {supplier.name} · custo = preço da cotação {pct ? <>+ <b>{pctText(pct)}%</b></> : '(sem acréscimo)'}
          </p>
        </div>
      </header>

      <label className="pquote-drop" data-filled={!!fileName || undefined}>
        <input type="file" accept=".xls,.xlsx,.csv,.pdf,text/csv,application/pdf,application/vnd.ms-excel,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" onChange={(e) => void onFile(e)} />
        <Icon name={fileName ? 'box' : 'upload'} size={22} />
        <strong>{busy && !lines ? 'Lendo a cotação…' : fileName || 'Escolher a cotação do fornecedor'}</strong>
        <small>{fileName ? 'Clique para trocar o arquivo' : 'Excel (.xls ou .xlsx), CSV ou PDF · nada é gravado antes de você confirmar'}</small>
      </label>

      {error && <p className="banner banner-error" role="alert">{error}</p>}

      {tax && tax.pct !== pct && (
        <div className="pquote-tax">
          <Icon name="info" size={18} />
          <p>
            Esta cotação tem <b>IPI de {pctText(tax.pct)}%</b> ({money(tax.ipi)}) e a pasta {supplier.name} usa {pctText(pct)}%.
          </p>
          <button type="button" className="act act-strong" disabled={busy} onClick={() => void usePct(tax.pct)}>Usar {pctText(tax.pct)}%</button>
        </div>
      )}

      {lines && lines.length > 0 && (
        <>
          <div className="pquote-meta">
            <label className="sku-input">
              <small>Nome da cotação (aparece em cada ficha)</small>
              <span className="sku-field"><input value={quoteRef} maxLength={200} onChange={(e) => setQuoteRef(e.target.value)} /></span>
            </label>
            <p><b>{chosen.length}</b> de {lines.length} itens</p>
          </div>
          <div className="pquote-table">
            <table>
              <thead>
                <tr>
                  <th><input type="checkbox" aria-label="Marcar todos" checked={allOn} onChange={(e) => setLines((ls) => ls!.map((l) => ({ ...l, on: e.target.checked })))} /></th>
                  <th>Produto</th>
                  <th className="num">Preço na cotação</th>
                  <th className="num">Custo na ficha</th>
                </tr>
              </thead>
              <tbody>
                {lines.map((l, i) => {
                  const c = parse(l.cost);
                  return (
                    <tr key={i} data-off={!l.on || undefined}>
                      <td><input type="checkbox" aria-label="Importar este item" checked={l.on} onChange={(e) => set(i, { on: e.target.checked })} /></td>
                      <td><textarea rows={1} aria-label="Nome do produto" value={l.title} maxLength={200} onChange={(e) => set(i, { title: e.target.value })} /></td>
                      <td className="num"><span className="pquote-money"><i>R$</i><input inputMode="decimal" value={l.cost} onChange={(e) => set(i, { cost: e.target.value })} /></span></td>
                      <td className="num"><b>{c === null ? '—' : money(costWithMarkup(c, pct))}</b></td>
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
