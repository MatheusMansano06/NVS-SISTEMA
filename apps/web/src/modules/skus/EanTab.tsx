import { useCallback, useEffect, useState } from 'react';
import { ean13Modules, officialGtinProblem, type InternalEanDto, type InternalEanListDto, type UpdateEanInput } from '@nvs/shared';
import { ApiError } from '../../shared/http';
import { Pagination } from '../../shared/ui/Pagination';
import { useAuth } from '../auth/AuthContext';
import { skusApi } from './skus-api';

type Format = 'rolo_1col' | 'rolo_2col' | 'a4';
const FORMATS: { id: Format; label: string }[] = [
  { id: 'rolo_1col', label: 'Rolo 50 × 30 mm' },
  { id: 'rolo_2col', label: 'Rolo 2 colunas 40 × 25 mm' },
  { id: 'a4', label: 'Folha A4 (50 × 30 mm)' },
];

const date = (iso: string) => new Date(iso).toLocaleDateString('pt-BR');

/** SVG do EAN-13 (módulos de 2px, guardas mais longas, dígitos embaixo) — prévia e download. */
function eanSvg(code: string) {
  const mods = ean13Modules(code);
  const m = 2;
  const quiet = 11 * m;
  const w = 95 * m + quiet + 7 * m;
  const barH = 70;
  const guard = (i: number) => i < 3 || (i >= 45 && i < 50) || i >= 92;
  const bars = [...mods]
    .map((b, i) => (b === '1' ? `<rect x="${quiet + i * m}" y="0" width="${m}" height="${guard(i) ? barH + 8 : barH}"/>` : ''))
    .join('');
  const t = (x: number, s: string) => `<text x="${x}" y="${barH + 20}" text-anchor="middle">${s}</text>`;
  const text = t(quiet - 8, code[0]!) + t(quiet + 24 * m, code.slice(1, 7)) + t(quiet + 71 * m, code.slice(7));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 -8 ${w} ${barH + 32}" width="${w * 2}" height="${(barH + 32) * 2}"><rect x="0" y="-8" width="${w}" height="${barH + 32}" fill="#fff"/><g fill="#000">${bars}</g><g font-family="Helvetica, Arial, sans-serif" font-size="16" font-weight="700" fill="#000">${text}</g></svg>`;
}

/** Baixa o código de barras como PNG (desenha o SVG num canvas). */
async function downloadPng(code: string) {
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(eanSvg(code))}`;
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  canvas.getContext('2d')!.drawImage(img, 0, 0);
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `ean-${code}.png`;
  a.click();
}

function BarcodeImg({ code }: { code: string }) {
  return <img className="ean-img" alt={`Código de barras ${code}`} src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(eanSvg(code))}`} />;
}

function useCopy() {
  const [copied, setCopied] = useState<string | null>(null);
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(text);
      window.setTimeout(() => setCopied((c) => (c === text ? null : c)), 1500);
    });
  };
  return { copied, copy };
}

/** Lote colado: uma linha por SKU, "SKU;descrição" (descrição opcional; aceita tab ou vírgula também). */
function parseBulk(text: string) {
  return text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [sku, ...rest] = l.split(/[;\t,]/);
      return { sku: sku!.trim() || null, description: rest.join(' ').trim() || null };
    });
}

/** Cadastro de SKUs › Códigos EAN: gera EAN-13 interno (circulação restrita GS1), livre ou já com SKU. */
export function EanTab() {
  const { session } = useAuth();
  const canManage = session?.user.role !== 'viewer';
  const { copied, copy } = useCopy();
  const [data, setData] = useState<InternalEanListDto | null>(null);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(10);
  const [q, setQ] = useState('');
  const [query, setQuery] = useState('');
  const [last, setLast] = useState<InternalEanDto | null>(null);
  const [newSku, setNewSku] = useState('');
  const [bulk, setBulk] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'error'; text: string } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [format, setFormat] = useState<Format>('rolo_1col');
  const [qty, setQty] = useState('1');

  useEffect(() => {
    const t = window.setTimeout(() => setQuery(q.trim()), 300);
    return () => window.clearTimeout(t);
  }, [q]);
  useEffect(() => setPage(1), [query, pageSize]);

  const load = useCallback(async () => {
    try {
      setData(await skusApi.eans({ q: query || undefined, offset: (page - 1) * pageSize, limit: pageSize }));
    } catch {
      setMsg({ kind: 'error', text: 'Não foi possível carregar os códigos.' });
    }
  }, [query, page, pageSize]);
  useEffect(() => void load(), [load]);

  async function generate(items: { sku: string | null; description: string | null }[]) {
    setBusy(true);
    setMsg(null);
    try {
      const r = await skusApi.generateEans(items);
      if (r.created.length === 1) setLast(r.created[0]!);
      else if (r.existing.length === 1 && !r.created.length) setLast(r.existing[0]!);
      setSelected(new Set(r.created.map((e) => e.code)));
      setNewSku('');
      setBulk(null);
      if (r.existing.length === 1) setMsg({ kind: 'ok', text: `${r.existing[0]!.sku} já tinha código — mostrei o dele, sem gerar outro.` });
      else if (r.existing.length) setMsg({ kind: 'ok', text: `${r.created.length} gerado(s); ${r.existing.length} SKUs já tinham código e foram mantidos.` });
      else if (r.created.length > 1) setMsg({ kind: 'ok', text: `${r.created.length} códigos gerados.` });
      setPage(1);
      await load();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Não foi possível gerar.' });
    } finally {
      setBusy(false);
    }
  }

  async function update(code: string, patch: UpdateEanInput) {
    const saved = await skusApi.updateEan(code, patch);
    setData((d) => d && { ...d, items: d.items.map((x) => (x.code === code ? saved : x)) });
    if (patch.sku !== undefined) void load(); // contador de livres
    if (last?.code === code) setLast(saved);
    return saved;
  }

  async function remove(e: InternalEanDto) {
    if (!window.confirm(`Excluir o código ${e.code}${e.sku ? ` do SKU ${e.sku}` : ''}? O número não volta a ser usado.`)) return;
    try {
      await skusApi.removeEan(e.code);
      if (last?.code === e.code) setLast(null);
      setSelected((s) => {
        const n = new Set(s);
        n.delete(e.code);
        return n;
      });
      await load();
    } catch (err) {
      setMsg({ kind: 'error', text: err instanceof ApiError ? err.message : 'Não foi possível excluir.' });
    }
  }

  const items = data?.items ?? [];
  const toggle = (code: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(code)) n.delete(code);
      else n.add(code);
      return n;
    });
  const allShown = items.length > 0 && items.every((e) => selected.has(e.code));
  const printCodes = [...selected].slice(0, 100);
  const qtyNum = Math.min(500, Math.max(1, Number(qty) || 1));

  return (
    <div className="ean">
      <section className="ean-hero">
        <div className="ean-gen">
          <button type="button" className="ean-new" disabled={!canManage || busy} onClick={() => void generate([{ sku: newSku.trim() || null, description: null }])}>
            <svg viewBox="0 0 48 48" width="56" height="56" fill="none" stroke="currentColor" strokeWidth="3" aria-hidden="true">
              <path d="M4 14V6h8M36 6h8v8M44 34v8h-8M12 42H4v-8" />
              <path d="M12 14v20M17 14v20M21 14v20M27 14v20M31 14v20M36 14v20" strokeWidth="2.4" />
            </svg>
            <span>
              <strong>{busy ? 'Gerando…' : 'Gerar novo'}</strong>
              <small>Código EAN-13</small>
            </span>
          </button>
          {canManage && (
            <label className="sku-input">
              <small>Associar a um SKU (opcional)</small>
              <span className="sku-field">
                <input value={newSku} onChange={(e) => setNewSku(e.target.value)} placeholder="deixe vazio para gerar livre" />
              </span>
            </label>
          )}
          {canManage && (
            <button type="button" className="link" onClick={() => setBulk(bulk === null ? '' : null)}>
              {bulk === null ? 'gerar vários de uma vez' : 'fechar'}
            </button>
          )}
        </div>

        <div className="ean-out">
          <div className="ean-out-box">
            <code>{last ? last.code : ''}</code>
            <button type="button" className="ean-icon" disabled={!last} onClick={() => last && copy(last.code)} aria-label="Copiar código" title="Copiar código">
              {last && copied === last.code ? '✓' : (
                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
              )}
            </button>
          </div>
          <div className="ean-out-box ean-out-img">
            {last ? <BarcodeImg code={last.code} /> : <span />}
            <button type="button" className="ean-icon" disabled={!last} onClick={() => last && void downloadPng(last.code)} aria-label="Baixar imagem" title="Baixar imagem (PNG)">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
            </button>
          </div>
          {last && <small className="ean-out-sku">{last.sku ? `SKU ${last.sku}` : 'Livre — associe a um SKU no histórico'}</small>}
        </div>
      </section>

      {bulk !== null && (
        <section className="scard ean-bulk">
          <label className="sku-input">
            <small>Um código por linha — SKU;descrição (linha vazia de SKU gera código livre; até 200)</small>
            <textarea rows={6} value={bulk} onChange={(e) => setBulk(e.target.value)} placeholder={'MOUSE-RGB-01;Mouse gamer RGB\nPAD-90X40;Mousepad 90x40\nCABO-USB-C'} />
          </label>
          <div className="ean-bulk-actions">
            <button type="button" className="btn btn-primary" disabled={busy || !parseBulk(bulk).length} onClick={() => void generate(parseBulk(bulk).slice(0, 200))}>
              {busy ? 'Gerando…' : `Gerar ${parseBulk(bulk).length || ''} código(s)`}
            </button>
          </div>
        </section>
      )}

      {msg && <p className={`banner banner-${msg.kind}`} role="status">{msg.text}</p>}

      <section className="ean-hist">
        <header className="ean-hist-head">
          <h2>Histórico <small>de códigos</small></h2>
          <span>Total de <b>{data?.total ?? '—'}</b>{data?.free ? ` · ${data.free} livre${data.free > 1 ? 's' : ''}` : ''}</span>
        </header>

        <div className="skus-toolbar ean-toolbar">
          <label className="search">
            <span className="sr-only">Buscar código</span>
            <input placeholder="Buscar por código, SKU ou descrição" value={q} onChange={(e) => setQ(e.target.value)} />
          </label>
          <div className="ean-print">
            <select value={format} onChange={(e) => setFormat(e.target.value as Format)} aria-label="Formato da etiqueta">
              {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
            </select>
            <label className="ean-qty">
              <span>cópias</span>
              <input inputMode="numeric" value={qty} onChange={(e) => setQty(e.target.value.replace(/\D/g, ''))} aria-label="Cópias de cada etiqueta" />
            </label>
            <a
              className="btn btn-primary btn-sm"
              aria-disabled={!printCodes.length || undefined}
              href={printCodes.length ? skusApi.eanLabelsUrl(printCodes, qtyNum, format) : undefined}
              target="_blank"
              rel="noreferrer"
            >
              Imprimir etiquetas{printCodes.length ? ` (${printCodes.length})` : ''}
            </a>
          </div>
        </div>

        {data && !data.total ? (
          <div className="skus-empty">
            <strong>{query ? 'Nada encontrado' : 'Nenhum código ainda'}</strong>
            <p>{query ? 'Tente outra busca.' : 'Clique em “Gerar novo” — cada código é único na sua empresa.'}</p>
          </div>
        ) : (
          <div className="ean-table" role="table" aria-busy={!data}>
            <div className="ean-tr ean-th" role="row">
              <span role="columnheader">
                <input type="checkbox" aria-label="Selecionar a página" checked={allShown} onChange={() => setSelected(allShown ? new Set() : new Set(items.map((e) => e.code)))} />
              </span>
              <span role="columnheader">Código</span>
              <span role="columnheader">SKU associado</span>
              <span role="columnheader">GTIN oficial (GS1)</span>
              <span role="columnheader">Criado em</span>
              <span role="columnheader" />
            </div>
            {items.map((e) => (
              <div key={e.code} className="ean-tr" role="row" data-selected={selected.has(e.code) || undefined}>
                <span role="cell"><input type="checkbox" aria-label={`Selecionar ${e.code}`} checked={selected.has(e.code)} onChange={() => toggle(e.code)} /></span>
                <span role="cell" className="ean-code">
                  <code>{e.code}</code>
                  {e.inMasterData && <span className="tag tag-active" title="Vale na bipagem do Full">bipa no Full</span>}
                </span>
                <span role="cell"><SkuCell ean={e} disabled={!canManage} onSave={(sku, description) => update(e.code, { sku, description })} /></span>
                <span role="cell"><GtinField ean={e} disabled={!canManage} onSave={(gtin) => update(e.code, { gtin })} /></span>
                <span role="cell" className="ean-date">{date(e.createdAt)}</span>
                <span role="cell" className="ean-actions">
                  <button type="button" className="ean-icon" onClick={() => copy(e.code)} aria-label={`Copiar ${e.code}`} title="Copiar">
                    {copied === e.code ? '✓' : <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>}
                  </button>
                  <button type="button" className="ean-icon" onClick={() => void downloadPng(e.code)} aria-label={`Baixar imagem de ${e.code}`} title="Baixar imagem (PNG)">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true"><path d="M12 4v11M7 10l5 5 5-5M5 20h14" /></svg>
                  </button>
                  {canManage && <button type="button" className="link link-danger" onClick={() => void remove(e)}>Excluir</button>}
                </span>
              </div>
            ))}
          </div>
        )}

        {data && data.total > 0 && (
          <Pagination page={page} pageSize={pageSize} total={data.total} onPage={setPage} onPageSize={setPageSize} sizes={[10, 25, 50]} label="códigos" />
        )}

        <p className="ean-note">
          Códigos começados em <b>20</b> são da faixa que a GS1 reserva para <b>uso interno</b>: nunca colidem com produto de outra
          empresa e servem para estoque, bipagem e etiquetas. Não use como GTIN no anúncio do marketplace (lá, marque “produto sem
          código universal”). Quando licenciar seu prefixo na GS1 Brasil, informe o GTIN oficial de cada produto — o interno
          continua valendo.
        </p>
      </section>
    </div>
  );
}

/** "Livre" vira campo para associar; SKU associado pode ser trocado ou liberado. */
function SkuCell({ ean, disabled, onSave }: { ean: InternalEanDto; disabled: boolean; onSave: (sku: string | null, description: string | null) => Promise<InternalEanDto> }) {
  const [editing, setEditing] = useState(false);
  const [sku, setSku] = useState(ean.sku ?? '');
  const [desc, setDesc] = useState(ean.description ?? '');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function save(next: string | null) {
    setBusy(true);
    try {
      await onSave(next, desc.trim() || null);
      setEditing(false);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    } finally {
      setBusy(false);
    }
  }

  if (!editing) {
    return (
      <div className="ean-sku">
        {ean.sku ? (
          <button type="button" className="ean-sku-btn" disabled={disabled} onClick={() => setEditing(true)} title="Trocar SKU">
            <strong>{ean.sku}</strong>
            {ean.description && <small>{ean.description}</small>}
          </button>
        ) : (
          <button type="button" className="tag tag-done ean-free" disabled={disabled} onClick={() => setEditing(true)} title="Associar a um SKU">
            Livre
          </button>
        )}
      </div>
    );
  }
  return (
    <form
      className="ean-sku-edit"
      onSubmit={(e) => {
        e.preventDefault();
        void save(sku.trim() || null);
      }}
    >
      <span className="sku-field"><input autoFocus value={sku} onChange={(e) => setSku(e.target.value)} placeholder="SKU" aria-label="SKU" /></span>
      <span className="sku-field"><input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="Descrição (etiqueta)" aria-label="Descrição" /></span>
      <span className="ean-sku-actions">
        <button type="submit" className="act act-strong" disabled={busy}>{busy ? '…' : 'Salvar'}</button>
        {ean.sku && <button type="button" className="link" disabled={busy} onClick={() => void save(null)}>liberar</button>}
        <button type="button" className="link" onClick={() => setEditing(false)}>cancelar</button>
      </span>
      {error && <small className="sku-error">{error}</small>}
    </form>
  );
}

function GtinField({ ean, disabled, onSave }: { ean: InternalEanDto; disabled: boolean; onSave: (gtin: string | null) => Promise<InternalEanDto> }) {
  const [value, setValue] = useState(ean.gtin ?? '');
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [error, setError] = useState('');
  const v = value.replace(/\D/g, '');
  const problem = v ? officialGtinProblem(v) : null;

  async function save() {
    if (v === (ean.gtin ?? '')) return;
    if (problem) {
      setState('error');
      setError(problem);
      return;
    }
    setState('saving');
    try {
      await onSave(v || null);
      setState('saved');
      setError('');
    } catch (err) {
      setState('error');
      setError(err instanceof ApiError ? err.message : 'Não foi possível salvar.');
    }
  }

  return (
    <label className="ean-gtin" data-state={state}>
      <span className="sku-field">
        <input
          inputMode="numeric"
          value={value}
          disabled={disabled}
          placeholder="ainda não registrado"
          aria-label={`GTIN oficial de ${ean.code}`}
          aria-invalid={problem ? true : undefined}
          onChange={(e) => {
            setValue(e.target.value);
            setState('idle');
          }}
          onBlur={() => void save()}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
        {state === 'saved' && <i aria-label="salvo">✓</i>}
      </span>
      {(problem || error) && <small className="sku-error">{problem ?? error}</small>}
    </label>
  );
}
