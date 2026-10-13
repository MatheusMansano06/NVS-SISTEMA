import { useEffect, useRef, useState, type FormEvent } from 'react';
import {
  RETURN_CLASS_LABELS,
  RETURN_PENDING_LABELS,
  RETURN_REASON_LABELS,
  RETURN_STATUS_LABELS,
  type ReturnCheckInput,
  type ReturnDetailDto,
} from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { photoToJpegBase64, returnsApi } from './returns-api';

const errMsg = (e: unknown) => (e instanceof ApiError ? Object.values(e.fieldErrors).flat()[0] ?? e.message : 'Não foi possível concluir.');
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const RESPONSIBLE: Record<string, string> = { comprador: 'Comprador', vendedor: 'Vendedor (nós)', a_definir: 'A definir' };
const STOCK: Record<string, string> = { vendavel: 'estoque vendável', avaria: 'avaria' };

/**
 * Conferência de uma devolução (o que o operador vê depois do bipe): o pedido, o checklist do que chegou na bancada,
 * a decisão (A/B/C, contestar ou não), fotos, contestação/aceite no ML e o que falta fazer.
 */
export function ReturnConference({ detail, onChange }: { detail: ReturnDetailDto; onChange: (d: ReturnDetailDto) => void }) {
  const { row } = detail;
  const item = row.items[0];
  const locked = Boolean(row.check?.stockDoneAt) || row.disputed;
  return (
    <div className="rc">
      <header className="rc-head">
        <ProductThumb src={item?.pictureUrl ?? null} alt={item?.name ?? 'Produto'} size={84} />
        <div className="rc-title">
          <span className="rc-badge" data-status={row.status}>{RETURN_STATUS_LABELS[row.status]}</span>
          <h2>{item?.name ?? 'Produto da devolução'}</h2>
          <p>
            {row.items.map((i) => `${i.qty}× ${i.sku ?? i.itemId ?? '?'}`).join(' · ')} · Pedido <b>{row.packId ?? row.orderId}</b>
          </p>
          <a className="link" href={row.link} target="_blank" rel="noreferrer">Abrir a venda no Mercado Livre ↗</a>
        </div>
      </header>
      <dl className="rc-facts">
        <div><dt>Motivo</dt><dd>{RETURN_REASON_LABELS[row.reason]}</dd></div>
        <div><dt>Responsável (ML)</dt><dd>{RESPONSIBLE[row.responsible]}</dd></div>
        <div><dt>Frete reverso cobrado</dt><dd>{row.platformCost === null ? '—' : money(row.platformCost)}</dd></div>
        <div><dt>Prazo para agir</dt><dd data-late={row.sellerDeadline && Date.parse(row.sellerDeadline) < Date.now() + 86_400_000 ? true : undefined}>{dt(row.sellerDeadline)}</dd></div>
        <div><dt>Rastreio</dt><dd>{row.tracking ?? '—'}</dd></div>
        <div><dt>Aberta em</dt><dd>{dt(row.openedAt)}</dd></div>
      </dl>
      {row.pending.length > 0 && (
        <p className="banner banner-warn rc-pending">Falta: {row.pending.map((p) => RETURN_PENDING_LABELS[p]).join(' · ')}</p>
      )}

      <Checklist key={row.check?.checkedAt ?? 'novo'} detail={detail} locked={locked} onChange={onChange} />
      {row.check && <Decision detail={detail} onChange={onChange} />}
      {!row.check && row.awaitingReview && <AcceptOnly />}

      {detail.disputes.length > 0 && (
        <section className="rc-box">
          <h3>Enviado ao ML</h3>
          <ul className="rc-history">
            {detail.disputes.map((d) => (
              <li key={d.id} data-ok={d.ok || undefined}>
                <b>{d.ok ? '✓' : '✗'} {d.path === 'aceite' ? 'Aceite' : d.path === 'mediacao' ? 'Mediação' : d.path === 'revisao_com_falha' ? 'Revisão com falha' : 'Tentativa'}</b>
                <span>{dt(d.sentAt)}{d.sentBy ? ` · ${d.sentBy}` : ''}</span>
                {d.error && <small className="sku-error">{d.error}</small>}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

type Answer = 'productCorrect' | 'complete' | 'unused' | 'resellable';
const QUESTIONS: { key: Answer; text: string; help?: string }[] = [
  { key: 'productCorrect', text: 'É o produto que foi vendido?', help: 'Confira SKU, modelo e cor com o pedido.' },
  { key: 'complete', text: 'Está completo?', help: 'Peças, acessórios e manual.' },
  { key: 'unused', text: 'Está sem sinais de uso?' },
  { key: 'resellable', text: 'Pode voltar para a venda?' },
];

function Checklist({ detail, locked, onChange }: { detail: ReturnDetailDto; locked: boolean; onChange: (d: ReturnDetailDto) => void }) {
  const c = detail.row.check;
  const [answers, setAnswers] = useState<Partial<Record<Answer | 'ourError', boolean>>>(
    c ? { productCorrect: c.productCorrect, complete: c.complete, unused: c.unused, resellable: c.resellable, ourError: c.ourError } : {},
  );
  const [sku, setSku] = useState(c?.skuReceived ?? '');
  const [note, setNote] = useState(c?.note ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const missing = QUESTIONS.filter((q) => answers[q.key] === undefined).length;
  const wrong = answers.productCorrect === false;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (missing) return;
    setBusy(true);
    setError('');
    try {
      const body: ReturnCheckInput = {
        productCorrect: answers.productCorrect!,
        complete: answers.complete!,
        unused: answers.unused!,
        resellable: answers.resellable!,
        ourError: wrong ? Boolean(answers.ourError) : false,
        skuReceived: sku.trim() || null,
        note: note.trim() || null,
      };
      onChange(await returnsApi.check(detail.row.id, body));
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="rc-box" onSubmit={submit}>
      <h3>O que chegou na bancada</h3>
      <fieldset disabled={locked || busy} className="rc-checklist">
        {QUESTIONS.map((q) => (
          <YesNo key={q.key} text={q.text} help={q.help} value={answers[q.key]} onPick={(v) => setAnswers((a) => ({ ...a, [q.key]: v, ...(q.key === 'productCorrect' && v ? { ourError: false } : {}) }))} />
        ))}
        {wrong && (
          <YesNo
            text="Fomos nós que enviamos esse produto por engano?"
            help="Se sim, a empresa assume e não contesta."
            value={answers.ourError}
            onPick={(v) => setAnswers((a) => ({ ...a, ourError: v }))}
          />
        )}
        <label className="rc-field">
          <small>SKU do produto que chegou {wrong ? '' : '(opcional)'}</small>
          <input value={sku} onChange={(e) => setSku(e.target.value)} placeholder="Bipe o código do produto" autoComplete="off" />
        </label>
        <label className="rc-field">
          <small>O que você viu</small>
          <textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Ex.: risco na lateral, caixa aberta, veio outra peça" />
        </label>
        <Replies text={note} onPick={setNote} />
        <button type="submit" className="full-dark-btn" disabled={missing > 0}>
          {busy ? 'Registrando…' : missing ? `Responda mais ${missing}` : c ? 'Atualizar conferência' : 'Registrar conferência'}
        </button>
      </fieldset>
      {locked && <p className="full-empty">{detail.row.disputed ? 'Já enviado ao ML' : 'Estoque já ajustado'}: a conferência não pode mais mudar.</p>}
      {error && <p className="banner banner-error">{error}</p>}
    </form>
  );
}

function YesNo({ text, help, value, onPick }: { text: string; help?: string; value: boolean | undefined; onPick: (v: boolean) => void }) {
  return (
    <div className="rc-yn">
      <span>
        <b>{text}</b>
        {help && <small>{help}</small>}
      </span>
      <span className="rc-yn-btns">
        <button type="button" aria-pressed={value === true} data-v="sim" onClick={() => onPick(true)}>Sim</button>
        <button type="button" aria-pressed={value === false} data-v="nao" onClick={() => onPick(false)}>Não</button>
      </span>
    </div>
  );
}

/** Frases prontas compartilhadas pela equipe: clicar preenche; "+" salva o texto atual. */
function Replies({ text, onPick }: { text: string; onPick: (t: string) => void }) {
  const [list, setList] = useState<{ id: string; text: string }[]>([]);
  useEffect(() => {
    returnsApi.replies().then(setList).catch(() => undefined);
  }, []);
  return (
    <div className="rc-replies">
      {list.map((r) => (
        <span key={r.id} className="rc-reply">
          <button type="button" onClick={() => onPick(text ? `${text} ${r.text}` : r.text)}>{r.text}</button>
          <button
            type="button"
            aria-label={`Excluir "${r.text}"`}
            onClick={() => window.confirm(`Excluir "${r.text}"?`) && void returnsApi.deleteReply(r.id).then(() => setList((l) => l.filter((x) => x.id !== r.id)))}
          >
            ×
          </button>
        </span>
      ))}
      {text.trim() && (
        <button type="button" className="link" onClick={() => void returnsApi.addReply(text.trim().slice(0, 300)).then((r) => setList((l) => [...l, r]))}>
          + salvar como resposta pronta
        </button>
      )}
    </div>
  );
}

/** O que a conferência decidiu e o que falta: estoque, contestar (com foto), aceitar, chamado manual. */
function Decision({ detail, onChange }: { detail: ReturnDetailDto; onChange: (d: ReturnDetailDto) => void }) {
  const { row } = detail;
  const c = row.check!;
  const [error, setError] = useState('');
  const [busy, setBusy] = useState('');
  const run = async (key: string, fn: () => Promise<ReturnDetailDto>) => {
    setBusy(key);
    setError('');
    try {
      onChange(await fn());
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy('');
    }
  };
  const lastFail = detail.disputes.find((d) => !d.ok && d.path !== 'aceite');
  return (
    <section className="rc-box rc-decision" data-class={c.class}>
      <h3>Decisão: classe {RETURN_CLASS_LABELS[c.class]}</h3>
      <p>{c.decision}</p>
      <p className="rc-loss">
        Prejuízo registrado: frete {c.reverseFreight === null ? '—' : money(c.reverseFreight)} + produto{' '}
        {c.productLoss === null ? 'sem custo cadastrado' : money(c.productLoss)}
      </p>

      {c.stockMoves.length > 0 && (
        <div className="rc-step" data-done={c.stockDoneAt ? true : undefined}>
          <b>1. Ajustar estoque</b>
          <ul>
            {c.stockMoves.map((m, i) => (
              <li key={i}>
                {m.type === 'E' ? 'Entrada' : 'Saída'} do SKU {m.sku === 'vendido' ? `vendido (${row.items[0]?.sku ?? '?'})` : `recebido (${c.skuReceived ?? '?'})`} em {STOCK[m.deposit]}
              </li>
            ))}
          </ul>
          {c.stockDoneAt ? (
            <small>✓ Ajustado em {dt(c.stockDoneAt)}</small>
          ) : (
            <button type="button" className="act act-strong" disabled={Boolean(busy)} onClick={() => void run('stock', () => returnsApi.stockDone(row.id))}>
              {busy === 'stock' ? 'Salvando…' : 'Já ajustei o estoque'}
            </button>
          )}
        </div>
      )}

      {c.dispute && !row.disputed && <Dispute detail={detail} onChange={onChange} />}
      {lastFail && c.dispute && !row.disputed && (
        <button type="button" className="link" onClick={() => void run('manual', () => returnsApi.toManual(row.id))}>
          A contestação pela API não passa? Mandar para chamado manual
        </button>
      )}
      {!c.dispute && !c.manualTicket && row.awaitingReview && !row.disputed && (
        <button type="button" className="act act-strong" disabled={Boolean(busy)} onClick={() => window.confirm('Aceitar a devolução no ML? O comprador é reembolsado.') && void run('accept', () => returnsApi.accept(row.id))}>
          {busy === 'accept' ? 'Enviando…' : 'Aceitar devolução no ML (chegou como esperado)'}
        </button>
      )}
      {c.manualTicket && <ManualTicket detail={detail} onChange={onChange} />}
      {error && <p className="banner banner-error">{error}</p>}
    </section>
  );
}

/** O ML espera a revisão: o aceite sai depois da conferência (é ela que diz se chegou como esperado). */
function AcceptOnly() {
  return <p className="full-empty rc-hint">O ML espera a sua revisão desta devolução. Confira o produto acima: se chegou como esperado, a conferência libera o aceite.</p>;
}

function Dispute({ detail, onChange }: { detail: ReturnDetailDto; onChange: (d: ReturnDetailDto) => void }) {
  const { row } = detail;
  const [reasons, setReasons] = useState<{ id: string; text: string }[] | null>(null);
  const [reason, setReason] = useState('');
  const [message, setMessage] = useState(row.check?.note ?? '');
  const [evidence, setEvidence] = useState(detail.evidence);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    returnsApi.reasons(row.id).then(setReasons).catch((e) => {
      setReasons([]);
      setError(errMsg(e));
    });
  }, [row.id]);
  useEffect(() => setEvidence(detail.evidence), [detail.evidence]);

  async function addPhotos(files: FileList | null) {
    if (!files?.length) return;
    setBusy('photo');
    setError('');
    try {
      for (const f of [...files]) {
        const p = await photoToJpegBase64(f);
        setEvidence(await returnsApi.addEvidence(row.id, p.mime, p.data));
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy('');
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function send(e: FormEvent) {
    e.preventDefault();
    setBusy('send');
    setError('');
    try {
      const d = await returnsApi.dispute(row.id, { reason, message });
      onChange(d);
      const last = d.disputes[0];
      if (last && !last.ok) setError(`O ML recusou: ${last.error ?? 'erro'}`);
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy('');
    }
  }

  return (
    <form className="rc-step" onSubmit={send}>
      <b>{row.check?.stockMoves.length ? '2.' : '1.'} Contestar no Mercado Livre</b>
      <small>Fotos do produto e da embalagem (obrigatório ao menos 1). O ML não aceita vídeo pela API: se precisar, anexe pelo painel.</small>
      <div className="rc-photos">
        {evidence.map((ev) => (
          <span key={ev.id} className="rc-photo">
            <img src={returnsApi.evidenceUrl(ev.id)} alt="Evidência" />
            <button type="button" aria-label="Remover foto" onClick={() => void returnsApi.deleteEvidence(ev.id).then(() => setEvidence((l) => l.filter((x) => x.id !== ev.id)))}>×</button>
          </span>
        ))}
        <button type="button" className="rc-addphoto" onClick={() => fileRef.current?.click()} disabled={busy === 'photo'}>
          {busy === 'photo' ? 'Enviando…' : '📷 Foto'}
        </button>
        <input ref={fileRef} type="file" accept="image/*" capture="environment" multiple hidden onChange={(e) => void addPhotos(e.target.files)} />
      </div>
      <label className="rc-field">
        <small>Motivo oficial do ML</small>
        <select value={reason} onChange={(e) => setReason(e.target.value)} required disabled={!reasons}>
          <option value="">{reasons ? 'Escolha o motivo…' : 'Carregando motivos do ML…'}</option>
          {reasons?.map((r) => <option key={r.id} value={r.id}>{r.text}</option>)}
        </select>
      </label>
      <label className="rc-field">
        <small>Explique o que aconteceu (vai para o ML)</small>
        <textarea rows={3} value={message} onChange={(e) => setMessage(e.target.value)} minLength={10} required />
      </label>
      <button type="submit" className="full-dark-btn" disabled={Boolean(busy) || !reason || !evidence.length || message.trim().length < 10}>
        {busy === 'send' ? 'Enviando ao ML…' : 'Contestar no ML'}
      </button>
      {error && <p className="banner banner-error">{error}</p>}
    </form>
  );
}

function ManualTicket({ detail, onChange }: { detail: ReturnDetailDto; onChange: (d: ReturnDetailDto) => void }) {
  const c = detail.row.check!;
  const [protocol, setProtocol] = useState('');
  const [error, setError] = useState('');
  if (c.ticketOpenedAt) return <p className="rc-step" data-done><b>Chamado aberto</b> <small>{dt(c.ticketOpenedAt)}{c.ticketProtocol ? ` · protocolo ${c.ticketProtocol}` : ''}</small></p>;
  return (
    <div className="rc-step">
      <b>Abrir chamado no Mercado Livre</b>
      <small>O ML não deixa contestar pela API nesta reclamação. Abra pelo painel (botão abaixo), anexe as fotos e anote o protocolo aqui.</small>
      <a className="act" href={detail.row.link} target="_blank" rel="noreferrer">Abrir a venda no ML ↗</a>
      <span className="full-inline">
        <input value={protocol} onChange={(e) => setProtocol(e.target.value)} placeholder="Protocolo do chamado (opcional)" />
        <button
          type="button"
          className="act act-strong"
          onClick={async () => {
            try {
              onChange(await returnsApi.ticketOpened(detail.row.id, protocol || undefined));
            } catch (err) {
              setError(errMsg(err));
            }
          }}
        >
          Chamado aberto
        </button>
      </span>
      {error && <p className="banner banner-error">{error}</p>}
    </div>
  );
}
