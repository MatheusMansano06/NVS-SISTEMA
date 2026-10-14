import { useCallback, useEffect, useRef, useState } from 'react';
import { WMS_ITEM_STATUS_LABELS, type WmsItemDto, type WmsListDetailDto, type WmsPrintJobDto, type WmsScanResultDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { usePerson } from '../operation/PersonContext';
import { fullApi } from './full-api';
import { ProductDock } from './ProductDock';

type Dialog =
  | { kind: 'box'; code: string; remaining: number }
  | { kind: 'shortage' }
  | { kind: 'oos' }
  | { kind: 'reprint' }
  | { kind: 'link'; code: string }
  | { kind: 'wrong'; text: string }
  | { kind: 'transfer'; itemId: string; sku: string; owner: string }
  | { kind: 'choose'; items: WmsItemDto[] }
  | { kind: 'items' };

const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : 'Não foi possível concluir.');

/** Separação de uma lista: bipa o produto em foco; ao concluir o item, as etiquetas vão para a Zebra. */
export function PickingScreen({ listId, focus: initialFocus, onBack, onOpen }: { listId: string; focus?: string; onBack: () => void; onOpen: (id: string, sku?: string) => void }) {
  const me = usePerson()!.person.person;
  const [detail, setDetail] = useState<WmsListDetailDto | null>(null);
  const [focus, setFocus] = useState<string | undefined>(initialFocus);
  const [code, setCode] = useState('');
  const [mode, setMode] = useState<'unit' | 'box'>('box');
  const [flash, setFlash] = useState<'ok' | 'error' | 'complete' | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [job, setJob] = useState<WmsPrintJobDto | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const pollRef = useRef<number | null>(null);

  const load = useCallback(() => fullApi.list(listId).then(setDetail).catch((e) => setMsg(errMsg(e))), [listId]);
  useEffect(() => {
    void load();
    return () => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
    };
  }, [load]);

  const item = detail ? (focus ? detail.items.find((i) => i.sku === focus) : undefined) ?? detail.current : null;
  const refocus = () => {
    window.setTimeout(() => !dialog && inputRef.current?.focus(), 60);
  };
  useEffect(refocus, [item?.id, dialog]);

  const blink = (k: 'ok' | 'error' | 'complete') => {
    setFlash(k);
    window.setTimeout(() => setFlash(null), 600);
  };

  /** Acompanha a impressão do item até sair (ou dar erro). */
  const watch = useCallback(
    (sku: string, first: WmsPrintJobDto | null | undefined) => {
      if (pollRef.current) window.clearTimeout(pollRef.current);
      setJob(first ?? null);
      let n = 0;
      const tick = async () => {
        const j = await fullApi.printStatus(listId, sku).catch(() => null);
        setJob(j);
        if (!j || j.status === 'PRINTED' || j.status === 'ERROR' || ++n > 40) return;
        pollRef.current = window.setTimeout(() => void tick(), 2000);
      };
      pollRef.current = window.setTimeout(() => void tick(), 1500);
    },
    [listId],
  );

  async function handle(r: WmsScanResultDto, scanned: string) {
    switch (r.status) {
      case 'ok':
        blink('ok');
        break;
      case 'complete': {
        blink('complete');
        if (r.item.labelsReady) watch(r.item.sku, r.print);
        setMsg(r.item.status === 'complete' ? `✓ ${r.item.sku} completo` : `${r.item.sku}: ${WMS_ITEM_STATUS_LABELS[r.item.status].toLowerCase()} (falta ${r.item.shortageQty})`);
        setFocus(undefined);
        break;
      }
      case 'excess':
        blink('error');
        setMsg(`${r.item.sku} já está completo (${r.item.qtyPicked}/${r.item.qtyRequired}).`);
        break;
      case 'unknown_barcode':
        blink('error');
        if (r.canLink && item) setDialog({ kind: 'link', code: scanned });
        else setDialog({ kind: 'wrong', text: `O código ${scanned} não está cadastrado${item ? '' : ''}. ${item && !r.canLink ? `O ${item.sku} já tem código: confira se pegou o produto certo ou peça para a Análise corrigir no Master Data.` : ''}` });
        return;
      case 'wrong_sku':
        blink('error');
        setDialog({ kind: 'wrong', text: `Esse código é do ${r.ownerSku}${r.ownerDescription ? ` (${r.ownerDescription})` : ''}, não do ${r.expectedSku}. Confira o produto.` });
        return;
      case 'wrong_list':
        blink('error');
        setDialog({ kind: 'wrong', text: `O ${r.sku}${r.description ? ` (${r.description})` : ''} não está nesta lista.` });
        return;
      case 'transfer_available':
        setDialog({ kind: 'transfer', itemId: r.itemId, sku: r.sku, owner: r.ownerName });
        return;
      case 'ambiguous':
        setDialog({ kind: 'choose', items: r.candidates });
        return;
    }
    await load();
  }

  async function run(fn: () => Promise<WmsScanResultDto>, scanned = '') {
    setBusy(true);
    setMsg('');
    try {
      await handle(await fn(), scanned);
    } catch (err) {
      blink('error');
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
      refocus();
    }
  }

  function onScan() {
    const c = code.trim();
    setCode('');
    if (!c || !item) return;
    if (c.toUpperCase() === item.sku.toUpperCase()) {
      blink('error');
      setMsg('O SKU não vale como bipagem: bipe o código de barras do produto.');
      return;
    }
    if (mode === 'box') setDialog({ kind: 'box', code: c, remaining: item.qtyRequired - item.qtyPicked });
    else void run(() => fullApi.scan(listId, { barcode: c, focusSku: focus ?? item.sku, mode: 'unit' }), c);
  }

  if (!detail) return msg ? <p className="banner banner-error">{msg}</p> : <div className="promo-skel" aria-hidden="true" />;
  const { list } = detail;
  const pct = list.itemsTotal ? Math.round((list.itemsPicked / list.itemsTotal) * 100) : 0;
  const othersList = list.operatorId && list.operatorId !== me.id;

  const pickable = (i: WmsItemDto) => !['complete', 'partial', 'out_of_stock'].includes(i.status);
  const left = detail.items.filter(pickable).length;

  const skusDone = detail.items.length - left;
  // itens já resolvidos (os últimos primeiro), como o "Acabaram de passar" do NVS-WMS
  const recent = detail.items.filter((i) => !pickable(i)).slice(-5).reverse();

  return (
    <div className="pk" data-flash={flash ?? undefined} onClick={() => !dialog && inputRef.current?.focus()}>
      <section className="pk-card">
        <header className="pk-head">
          <button type="button" className="pk-link" onClick={onBack}>‹ Voltar</button>
          <div className="pk-list">
            <b><span className="pk-mp" data-mp={list.marketplace} aria-hidden="true">{list.marketplace === 'shopee' ? 'S' : 'ML'}</span>{list.code}</b>
            <small>{int(list.itemsPicked)}/{int(list.itemsTotal)} un · {skusDone}/{detail.items.length} sku</small>
          </div>
          <button type="button" className="pk-link" onClick={(e) => { e.stopPropagation(); setDialog({ kind: 'items' }); }}>Itens ☰</button>
        </header>
        <span className="pk-bar" aria-hidden="true"><i style={{ width: `${pct}%` }} /></span>

        {othersList && <p className="pk-warn">Esta lista está com {list.operatorName}. Ao bipar, o sistema oferece transferir o item para você.</p>}

        {!item ? (
          <div className="pk-done">
            <span aria-hidden="true">🎉</span>
            <h2>Lista concluída!</h2>
            <p>{detail.items.filter((i) => i.shortageQty > 0).length ? 'Os itens com falta foram para o Relatório de Faltas.' : 'Tudo separado e etiquetado.'}</p>
            <button type="button" className="pk-btn pk-primary" onClick={onBack}>Voltar ao painel</button>
          </div>
        ) : (
          <div className="pk-body">
            <div className="pk-item">
              <ProductThumb src={item.pictureUrl} alt={item.description} size={84} />
              <div>
                <span className="pk-kicker">⚡ Separar agora</span>
                <h2>{item.sku}</h2>
                <p>{item.description}</p>
              </div>
              <span className="pk-status" data-item={item.status}>{WMS_ITEM_STATUS_LABELS[item.status]}</span>
            </div>

            <div className="pk-mode" role="tablist" aria-label="Modo de bipagem">
              <button type="button" role="tab" aria-checked={mode === 'unit'} data-mode="unit" onMouseDown={(e) => e.preventDefault()} onClick={() => setMode('unit')}>
                <i aria-hidden="true">1</i> Bipe unitário
              </button>
              <button type="button" role="tab" aria-checked={mode === 'box'} data-mode="box" onMouseDown={(e) => e.preventDefault()} onClick={() => setMode('box')}>
                <i aria-hidden="true">📦</i> Caixa
              </button>
            </div>

            <input
              ref={inputRef}
              className="pk-scan"
              value={code}
              disabled={busy}
              autoComplete="off"
              placeholder="BIPE O CÓDIGO DE BARRAS AQUI…"
              aria-label="Código de barras"
              onChange={(e) => setCode(e.target.value)}
              // keyup: o leitor manda Enter no fim; abrir o diálogo no keydown deixava o resto da tecla cair nele
              onKeyUp={(e) => e.key === 'Enter' && onScan()}
            />
            {mode === 'box' && <p className="pk-hint">1 bipe = 1 caixa: em seguida você informa quantas unidades tem.</p>}

            <div className="pk-count" aria-live="polite" data-full={item.qtyPicked >= item.qtyRequired || undefined}>
              <p><b>{item.qtyPicked}</b><span>/ {item.qtyRequired} un</span></p>
              <span className="pk-bar"><i style={{ width: `${Math.min(100, (item.qtyPicked / Math.max(1, item.qtyRequired)) * 100)}%` }} /></span>
            </div>

            {msg && <p className="pk-msg">{msg}</p>}

            <div className="pk-actions">
              <button type="button" className="pk-btn pk-danger" onClick={() => setDialog({ kind: 'oos' })}>✕ Sem estoque (relatório)</button>
              <button type="button" className="pk-btn pk-outline" disabled={busy || item.qtyPicked === 0} onClick={() => void fullApi.undo(listId, item.sku).then(load).catch((e) => setMsg(errMsg(e)))}>
                ↶ Desfazer último bipe
              </button>
              <button type="button" className="pk-link pk-small" title="Só para produtos marcados no Master Data como sem código físico" onClick={() => void run(() => fullApi.manualPick(listId, item.sku, mode))}>
                Produto sem código de barras? Separar sem código
              </button>
            </div>

            <PrintZone
              job={job}
              ready={item.labelsReady}
              qty={item.qtyPicked || item.qtyRequired}
              zplUrl={fullApi.zplUrl(listId, job?.sku ?? item.sku)}
              onPrint={() => setDialog({ kind: 'reprint' })}
              onRetry={() => job && void fullApi.print(listId, job.sku).then((j) => watch(j.sku, j))}
            />
          </div>
        )}
      </section>

      {item && recent.length > 0 && (
        <section className="pk-recent" aria-label="Acabaram de passar">
          <h3>Acabaram de passar</h3>
          {recent.map((r) => (
            <div key={r.id}>
              <i data-item={r.status} aria-hidden="true" />
              <b>{r.sku}</b>
              <span>{r.qtyPicked} un.</span>
              {r.shortageQty > 0 && <em>{r.shortageQty} falta</em>}
              <button type="button" className="pk-link" onClick={(e) => { e.stopPropagation(); setFocus(r.sku); }}>Abrir correção</button>
            </div>
          ))}
        </section>
      )}

      <ProductDock items={detail.items} currentId={item?.id ?? null} onPick={(sku) => setFocus(sku)} />

      <Modal open={dialog !== null} onClose={() => setDialog(null)} label="Separação" wide>
        {dialog && item && (
          <DialogBody
            dialog={dialog}
            item={item}
            items={detail.items}
            onClose={() => setDialog(null)}
            onBox={(qty) => {
              const d = dialog as Extract<Dialog, { kind: 'box' }>;
              setDialog(null);
              void run(() => fullApi.scan(listId, { barcode: d.code, focusSku: focus ?? item.sku, mode: 'box', qty }), d.code);
            }}
            onShortage={(qty, notes) => {
              setDialog(null);
              void run(() => fullApi.shortage(listId, item.sku, qty, notes));
            }}
            onOos={(notes) => {
              setDialog(null);
              void run(() => fullApi.outOfStock(listId, item.sku, notes));
            }}
            onReprint={async (qty) => {
              setDialog(null);
              try {
                watch(item.sku, await fullApi.print(listId, item.sku, qty));
              } catch (e) {
                setMsg(errMsg(e));
              }
            }}
            onLink={async () => {
              const d = dialog as Extract<Dialog, { kind: 'link' }>;
              setDialog(null);
              try {
                await fullApi.linkBarcode(d.code, item.sku);
                setMsg(`Código ${d.code} vinculado ao ${item.sku}.`);
                if (mode === 'box') setDialog({ kind: 'box', code: d.code, remaining: item.qtyRequired - item.qtyPicked });
                else void run(() => fullApi.scan(listId, { barcode: d.code, focusSku: item.sku, mode: 'unit' }), d.code);
              } catch (e) {
                setMsg(errMsg(e));
              }
            }}
            onTransfer={async () => {
              const d = dialog as Extract<Dialog, { kind: 'transfer' }>;
              setDialog(null);
              try {
                const t = await fullApi.transfer(d.itemId);
                onOpen(t.listId, d.sku);
              } catch (e) {
                setMsg(errMsg(e));
              }
            }}
            onPick={(sku) => {
              setDialog(null);
              setFocus(sku);
            }}
          />
        )}
      </Modal>
    </div>
  );
}

/** Zona de impressão (como no NVS-WMS): só aparece quando o item tem etiqueta pronta ou já foi para a fila. */
function PrintZone(p: { job: WmsPrintJobDto | null; ready: boolean; qty: number; zplUrl: string; onPrint: () => void; onRetry: () => void }) {
  const { job } = p;
  if (!job && !p.ready) return null;
  return (
    <div className="pk-print">
      {!job && <button type="button" className="pk-btn pk-ok" onClick={p.onPrint}>🖨 Imprimir {p.qty} etiquetas</button>}
      {job?.status === 'PENDING' && <p data-s="queue">⟳ Na fila de impressão… o agente está ligado?</p>}
      {job?.status === 'PRINTING' && <p data-s="printing">⟳ Enviando ao agente de impressão…</p>}
      {job?.status === 'PRINTED' && (
        <>
          <p data-s="done">✓ {job.labels} etiqueta(s) impressas{job.printerName ? ` em ${job.printerName}` : ''}</p>
          <button type="button" className="pk-btn pk-soft" onClick={p.onPrint}>⟳ Reimprimir</button>
        </>
      )}
      {job?.status === 'ERROR' && (
        <>
          <p data-s="error">{job.error ?? 'Falha no agente de impressão. Verifique o agente no computador.'}</p>
          <span className="pk-row">
            <button type="button" className="pk-btn pk-danger" onClick={p.onRetry}>Tentar de novo</button>
            <a className="pk-btn pk-soft" href={p.zplUrl} download>Baixar ZPL</a>
          </span>
        </>
      )}
    </div>
  );
}

function DialogBody(p: {
  dialog: Dialog;
  item: WmsItemDto;
  items: WmsItemDto[];
  onClose: () => void;
  onBox: (qty: number) => void;
  onShortage: (qty: number, notes?: string) => void;
  onOos: (notes?: string) => void;
  onReprint: (qty: number) => void;
  onLink: () => void;
  onTransfer: () => void;
  onPick: (sku: string) => void;
}) {
  const { dialog: d, item } = p;
  const [n, setN] = useState(d.kind === 'box' ? d.remaining : d.kind === 'reprint' ? Math.max(1, item.qtyPicked || item.qtyRequired) : item.qtyPicked);
  const [notes, setNotes] = useState('');
  const num = (label: string, max: number) => (
    <label>
      <small>{label}</small>
      <input type="number" min={0} max={max} value={n} autoFocus onFocus={(e) => e.target.select()} onChange={(e) => setN(Math.max(0, Math.min(max, Number(e.target.value) || 0)))} />
    </label>
  );
  switch (d.kind) {
    case 'box':
      return (
        <form className="full-modal" onSubmit={(e) => { e.preventDefault(); p.onBox(n); }}>
          <h2>Quantas unidades de {item.sku}?</h2>
          <p>Faltam {d.remaining}. Se achou menos, o resto vai como falta. Zero = sem estoque.</p>
          {num('Unidades encontradas', d.remaining)}
          <button type="submit" className="full-dark-btn">Confirmar</button>
        </form>
      );
    case 'shortage':
      return (
        <form className="full-modal" onSubmit={(e) => { e.preventDefault(); p.onShortage(n, notes || undefined); }}>
          <h2>Falta no {item.sku}</h2>
          <p>Quantas unidades você achou de {item.qtyRequired}? As etiquetas saem para as que achou.</p>
          {num('Unidades encontradas', item.qtyRequired)}
          <label><small>Observação (opcional)</small><input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} /></label>
          <button type="submit" className="full-dark-btn">Registrar falta</button>
        </form>
      );
    case 'oos':
      return (
        <form className="full-modal" onSubmit={(e) => { e.preventDefault(); p.onOos(notes || undefined); }}>
          <h2>{item.sku} sem estoque?</h2>
          <p>O que já foi bipado ({item.qtyPicked}) fica; o restante vai para o relatório de faltas.</p>
          <label><small>Observação (opcional)</small><input value={notes} maxLength={300} onChange={(e) => setNotes(e.target.value)} autoFocus /></label>
          <button type="submit" className="full-dark-btn">Confirmar sem estoque</button>
        </form>
      );
    case 'reprint':
      return (
        <form className="full-modal" onSubmit={(e) => { e.preventDefault(); if (n > 0) p.onReprint(n); }}>
          <h2>Imprimir etiquetas do {item.sku}</h2>
          <p>Código {item.mlCode ?? item.sku} · 2 por linha.</p>
          {num('Quantidade de etiquetas', 5000)}
          <button type="submit" className="full-dark-btn">Imprimir</button>
        </form>
      );
    case 'link':
      return (
        <div className="full-modal">
          <h2>Código novo</h2>
          <p>O código <b>{d.code}</b> ainda não está cadastrado. É mesmo do <b>{item.sku}</b> ({item.description})?</p>
          <div className="full-modal-acts">
            <button type="button" className="act" onClick={p.onClose}>Não, conferir</button>
            <button type="button" className="full-dark-btn" onClick={p.onLink} data-autofocus>Sim, vincular e bipar</button>
          </div>
        </div>
      );
    case 'wrong':
      return (
        <div className="full-modal">
          <h2>Atenção</h2>
          <p>{d.text}</p>
          <button type="button" className="full-dark-btn" onClick={p.onClose} data-autofocus>Entendi</button>
        </div>
      );
    case 'transfer':
      return (
        <div className="full-modal">
          <h2>Item de outra lista</h2>
          <p>O <b>{d.sku}</b> está com <b>{d.owner}</b>. Transferir para você e separar agora?</p>
          <div className="full-modal-acts">
            <button type="button" className="act" onClick={p.onClose}>Cancelar</button>
            <button type="button" className="full-dark-btn" onClick={p.onTransfer} data-autofocus>Transferir</button>
          </div>
        </div>
      );
    case 'choose':
    case 'items':
      return (
        <div className="full-modal">
          <h2>{d.kind === 'choose' ? 'Qual destes produtos?' : 'Itens da lista'}</h2>
          <ul className="full-choices">
            {(d.kind === 'choose' ? d.items : p.items).map((i) => (
              <li key={i.id}>
                <button type="button" onClick={() => p.onPick(i.sku)} disabled={d.kind === 'items' && ['complete', 'partial', 'out_of_stock'].includes(i.status)}>
                  <ProductThumb src={i.pictureUrl} alt={i.description} size={36} />
                  <span className="full-item-sku"><b>{i.sku}</b><small>{i.description}</small></span>
                  <span className="full-choice-meta">
                    <span className="full-badge" data-item={i.status}>{WMS_ITEM_STATUS_LABELS[i.status]}</span>
                    <small>{i.qtyPicked}/{i.qtyRequired}</small>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      );
  }
}
