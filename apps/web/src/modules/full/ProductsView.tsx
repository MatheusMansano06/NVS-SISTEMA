import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { WmsProductDto, WmsProductPageDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Button } from '../../shared/ui/Button';
import { Modal } from '../../shared/ui/Modal';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { useSupervisor } from './BatchesView';
import { fullApi } from './full-api';

const errMsg = (err: unknown) => (err instanceof ApiError ? Object.values(err.fieldErrors).flat()[0] ?? err.message : 'Não foi possível concluir.');

/**
 * Master Data: cada SKU com os códigos que valem na bipagem (Código ML, EAN…). É daqui que a separação sabe
 * que produto é cada código — e onde se corrige código cadastrado no produto errado.
 */
export function ProductsView() {
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<WmsProductPageDto | null>(null);
  const [editing, setEditing] = useState<WmsProductDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [msg, setMsg] = useState('');
  const [error, setError] = useState('');
  const canEdit = useSupervisor();
  const fileRef = useRef<HTMLInputElement>(null);

  const load = (query = q, p = page) =>
    fullApi
      .products(query, p)
      .then((r) => setData(p === 1 ? r : (prev) => (prev ? { total: r.total, items: [...prev.items, ...r.items] } : r)))
      .catch((e) => setError(errMsg(e)));
  useEffect(() => {
    const t = window.setTimeout(() => {
      setPage(1);
      void load(q, 1);
    }, 250);
    return () => window.clearTimeout(t);
  }, [q]);

  const say = (t: string) => {
    setMsg(t);
    window.setTimeout(() => setMsg((m) => (m === t ? '' : m)), 6000);
  };
  const replace = (p: WmsProductDto) => setData((d) => (d ? { ...d, items: d.items.map((x) => (x.sku === p.sku ? p : x)) } : d));

  async function importCsv(f: File) {
    setError('');
    try {
      const r = await fullApi.importProducts(await f.text());
      say(`${int(r.products)} produto(s) lidos, ${int(r.codes)} código(s) novos.`);
      void load(q, 1);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <div className="full-products">
      <div className="full-prod-bar">
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input value={q} placeholder="Buscar por SKU, descrição ou código de barras (EAN)…" onChange={(e) => setQ(e.target.value)} />
        </label>
        {canEdit && (
          <span className="full-prod-acts">
            <button type="button" className="act" onClick={() => fileRef.current?.click()} title="CSV: SKU;Descrição;EAN1;EAN2;EAN3">Importar planilha</button>
            <input ref={fileRef} type="file" accept=".csv,text/csv" hidden onChange={(e) => e.target.files?.[0] && void importCsv(e.target.files[0])} />
            <Button type="button" onClick={() => setCreating(true)}>+ Novo produto</Button>
          </span>
        )}
      </div>
      {msg && <p className="banner banner-ok" role="status">{msg}</p>}
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {!data ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : (
        <section className="full-box full-prod-table">
          <p className="full-kicker">{int(data.items.length)} de {int(data.total)} produtos</p>
          {!data.items.length && <p className="full-empty">Nada encontrado. Os produtos entram aqui sozinhos quando um PDF do envio é processado.</p>}
          {data.items.map((p) => (
            <div key={p.sku} className="full-prod">
              <ProductThumb src={p.pictureUrl} alt={p.description ?? p.sku} size={40} />
              <span className="full-item-sku">
                <b>{p.sku}</b>
                <small>{p.description ?? <em>sem descrição</em>}{p.noPhysicalBarcode ? ' · separa sem bipar' : ''}</small>
              </span>
              <span className="full-codes">
                {p.codes.length ? p.codes.map((c) => <code key={c}>{c}</code>) : <em>sem código</em>}
              </span>
              {canEdit && <button type="button" className="act" onClick={() => setEditing(p)}>Editar</button>}
            </div>
          ))}
          {data.items.length < data.total && (
            <button type="button" className="act load-more" onClick={() => { const n = page + 1; setPage(n); void load(q, n); }}>Carregar mais</button>
          )}
        </section>
      )}

      <Modal open={creating} onClose={() => setCreating(false)} label="Novo produto">
        {creating && (
          <NewProduct
            onDone={(p) => {
              setCreating(false);
              say(`${p.sku} cadastrado.`);
              void load(q, 1);
            }}
          />
        )}
      </Modal>
      <Modal open={editing !== null} onClose={() => setEditing(null)} label="Editar produto">
        {editing && (
          <EditProduct
            product={editing}
            onChange={(p) => {
              setEditing(p);
              replace(p);
            }}
            onDeleted={() => {
              say(`${editing.sku} removido.`);
              setEditing(null);
              void load(q, 1);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

function NewProduct({ onDone }: { onDone: (p: WmsProductDto) => void }) {
  const [sku, setSku] = useState('');
  const [desc, setDesc] = useState('');
  const [codes, setCodes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      onDone(await fullApi.createProduct({ sku, description: desc || undefined, codes: codes.split(/[\s,;]+/).filter(Boolean) }));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="full-modal" onSubmit={submit}>
      <h2>Novo produto</h2>
      <label><small>SKU</small><input value={sku} required maxLength={100} onChange={(e) => setSku(e.target.value.toUpperCase())} autoFocus /></label>
      <label><small>Descrição</small><input value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} /></label>
      <label>
        <small>Códigos de barras (EAN, Código ML…) — bipe um por um</small>
        <textarea rows={3} value={codes} onChange={(e) => setCodes(e.target.value)} placeholder={'7891234567895\nIBFJ71702'} />
      </label>
      {error && <p className="banner banner-error">{error}</p>}
      <Button type="submit" loading={busy} disabled={!sku.trim()}>Cadastrar</Button>
    </form>
  );
}

function EditProduct({ product, onChange, onDeleted }: { product: WmsProductDto; onChange: (p: WmsProductDto) => void; onDeleted: () => void }) {
  const [desc, setDesc] = useState(product.description ?? '');
  const [code, setCode] = useState('');
  const [error, setError] = useState('');
  const [warn, setWarn] = useState('');
  const run = async (fn: () => Promise<WmsProductDto | void>) => {
    setError('');
    try {
      const p = await fn();
      if (p) onChange(p);
    } catch (err) {
      setError(errMsg(err));
    }
  };
  return (
    <div className="full-modal">
      <h2>{product.sku}</h2>
      <label>
        <small>Descrição</small>
        <span className="full-inline">
          <input value={desc} maxLength={300} onChange={(e) => setDesc(e.target.value)} />
          <button type="button" className="act" disabled={desc === (product.description ?? '')} onClick={() => void run(() => fullApi.updateProduct(product.sku, { description: desc || null }))}>Salvar</button>
        </span>
      </label>
      <div>
        <small className="full-label">Códigos que valem na bipagem</small>
        <div className="full-codes full-codes-edit">
          {product.codes.map((c) => (
            <code key={c}>
              {c}
              <button
                type="button"
                aria-label={`Remover ${c}`}
                onClick={() => window.confirm(`Tirar o código ${c} do ${product.sku}?`) && void run(() => fullApi.removeCode(product.sku, c))}
              >
                ×
              </button>
            </code>
          ))}
          {!product.codes.length && <em>sem código — o operador vai precisar vincular na primeira bipagem</em>}
        </div>
        <form
          className="full-inline"
          onSubmit={(e) => {
            e.preventDefault();
            const c = code.trim();
            if (!c) return;
            void run(async () => {
              const r = await fullApi.addCode(product.sku, c);
              setCode('');
              setWarn(r.alsoOn.length ? `Atenção: ${c} também está em ${r.alsoOn.join(', ')}. Se foi vínculo errado, remova lá.` : '');
              return r.product;
            });
          }}
        >
          <input value={code} placeholder="Bipe ou digite um código novo" onChange={(e) => setCode(e.target.value)} />
          <button type="submit" className="act act-strong" disabled={!code.trim()}>Adicionar</button>
        </form>
      </div>
      <label className="full-check">
        <input type="checkbox" checked={product.noPhysicalBarcode} onChange={(e) => void run(() => fullApi.updateProduct(product.sku, { noPhysicalBarcode: e.target.checked }))} />
        Produto sem código físico (pode ser separado sem bipar)
      </label>
      {warn && <p className="banner banner-warn">{warn}</p>}
      {error && <p className="banner banner-error">{error}</p>}
      <button
        type="button"
        className="act act-danger full-del"
        onClick={() => window.confirm(`Apagar ${product.sku} e todos os códigos dele do Master Data?`) && void run(async () => { await fullApi.deleteProduct(product.sku); onDeleted(); })}
      >
        Apagar produto
      </button>
    </div>
  );
}
