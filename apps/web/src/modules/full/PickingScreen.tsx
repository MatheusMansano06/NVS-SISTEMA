import { useCallback, useEffect, useRef, useState } from 'react';
import { WMS_ITEM_STATUS_LABELS, type WmsItemDto, type WmsListDetailDto, type WmsPrintJobDto, type WmsScanResultDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { usePerson } from '../operation/PersonContext';
import { fullApi } from './full-api';

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

  return (
    <div className="full-pick" data-flash={flash ?? undefined}>
      <header className="full-pick-head">
        <button type="button" className="link" onClick={onBack}>‹ Voltar</button>
        <div>
          <b>{list.code}</b>
          <small>{list.operatorName ? `com ${list.operatorName}` : 'livre'} · {int(list.itemsPicked)}/{int(list.itemsTotal)} un. · {pct}%</small>
        </div>
        <button type="button" className="act" onClick={() => setDialog({ kind: 'items' })}>Itens ({detail.items.length})</button>
      </header>
      <span className="full-track full-pick-bar" data-tone={pct === 100 ? 'ok' : 'blue'}><i style={{ width: `${pct}%` }} /></span>
      {othersList && <p className="banner banner-warn">Esta lista está com {list.operatorName}. Ao bipar, o sistema oferece transferir o item para você.</p>}

      {!item ? (
        <section className="full-box full-pick-done">
          <h2>Lista concluída 🎉</h2>
          <p>{detail.items.filter((i) => i.shortageQty > 0).length ? 'Itens com falta foram para o relatório de faltas.' : 'Tudo separado.'}</p>
          <button type="button" className="full-dark-btn" onClick={onBack}>Voltar ao painel</button>
        </section>
      ) : (
        <section className="full-box full-pick-card">
          <div className="full-pick-prod">
            <ProductThumb src={item.pictureUrl} alt={item.description} size={96} />
            <div>
              <span className="full-badge" data-item={item.status}>{WMS_ITEM_STATUS_LABELS[item.status]}</span>
              <h2>{item.sku}</h2>
              <p>{item.description}</p>
              <small>{list.marketplace === 'shopee' ? 'Shopee SKU ID' : 'Código ML'}: <b>{item.mlCode ?? '—'}</b>{item.ean ? ` · EAN ${item.ean}` : ''}</small>
            </div>
          </div>
          <div className="full-pick-qty">
            <b>{item.qtyPicked}</b>
            <span>de {item.qtyRequired}</span>
          </div>
          <div className="seg full-pick-mode" role="tablist" aria-label="Modo de bipagem">
            <button type="button" role="tab" aria-checked={mode === 'box'} onClick={() => setMode('box')}>📦 Caixa (bipa 1x)</button>
            <button type="button" role="tab" aria-checked={mode === 'unit'} onClick={() => setMode('unit')}>Unidade a unidade</button>
          </div>
          <input
            ref={inputRef}
            className="full-scan"
            value={code}
            disabled={busy}
            autoComplete="off"
            placeholder="Bipe o código de barras…"
            onChange={(e) => setCode(e.target.value)}
            // keyup: o leitor manda Enter no fim; abrir o diálogo no keydown deixava o resto da tecla cair nele
            onKeyUp={(e) => e.key === 'Enter' && onScan()}
          />
          {msg && <p className="full-pick-msg">{msg}</p>}
          <PrintStatus job={job} zplUrl={fullApi.zplUrl(listId, job?.sku ?? item.sku)} onRetry={() => job && void fullApi.print(listId, job.sku).then((j) => watch(j.sku, j))} />
          <div className="full-pick-acts">
            <button type="button" className="act" disabled={busy || item.qtyPicked === 0} onClick={() => void fullApi.undo(listId, item.sku).then(load).catch((e) => setMsg(errMsg(e)))}>↶ Desfazer 1</button>
            <button type="button" className="act" onClick={() => setDialog({ kind: 'shortage' })}>Falta</button>
            <button type="button" className="act act-danger" onClick={() => setDialog({ kind: 'oos' })}>Sem estoque</button>
            <button type="button" className="act" onClick={() => setDialog({ kind: 'reprint' })}>🖨 Etiquetas</button>
            <button type="button" className="act" title="Só para produtos marcados no Master Data como sem código físico" onClick={() => void run(() => fullApi.manualPick(listId, item.sku, mode))}>
              Sem código?
            </button>
          </div>
        </section>
      )}

      <Modal open={dialog !== null} onClose={() => setDialog(null)} label="Separação">
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

function PrintStatus({ job, zplUrl, onRetry }: { job: WmsPrintJobDto | null; zplUrl: string; onRetry: () => void }) {
  if (!job) return null;
  const text =
    job.status === 'PRINTED'
      ? `🖨 ${job.labels} etiqueta(s) do ${job.sku} impressas${job.printerName ? ` em ${job.printerName}` : ''}`
      : job.status === 'ERROR'
        ? `Erro ao imprimir ${job.sku}: ${job.error ?? 'agente'}`
        : job.status === 'PRINTING'
          ? `Imprimindo ${job.labels} etiqueta(s) do ${job.sku}…`
          : `${job.labels} etiqueta(s) do ${job.sku} na fila — o agente da Zebra está ligado?`;
  return (
    <p className="full-print" data-status={job.status}>
      {text}
      {job.status === 'ERROR' && <button type="button" className="link" onClick={onRetry}>Tentar de novo</button>}
      {job.status !== 'PRINTED' && <a className="link" href={zplUrl} download>Baixar ZPL</a>}
    </p>
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
