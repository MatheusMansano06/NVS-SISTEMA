import { useCallback, useEffect, useRef, useState } from 'react';
import {
  RETURN_PENDING_LABELS,
  RETURN_REASON_LABELS,
  RETURN_SHIPPING_LABELS,
  RETURN_STATUS_LABELS,
  RETURN_STATUSES,
  type ReturnBiDto,
  type ReturnDetailDto,
  type ReturnListDto,
  type ReturnRowDto,
  type ReturnStatus,
  type ReturnSummaryDto,
} from '@nvs/shared';
import { int, money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { ReturnConference } from './ReturnConference';
import { returnsApi } from './returns-api';

const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Não foi possível carregar.');
const dt = (iso: string | null) => (iso ? new Date(iso).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—');
const ago = (iso: string | null) => {
  if (!iso) return 'nunca';
  const m = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  return m < 1 ? 'agora' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.round(m / 60)} h` : dt(iso);
};

/** Abre a conferência de uma devolução por id (modal) e avisa quando muda. */
export function useConference(onChanged: () => void) {
  const [detail, setDetail] = useState<ReturnDetailDto | null>(null);
  const open = (id: string) => returnsApi.detail(id).then(setDetail).catch(() => undefined);
  const element = (
    <Modal open={detail !== null} onClose={() => { setDetail(null); onChanged(); }} label="Conferência da devolução" wide>
      {detail && <ReturnConference detail={detail} onChange={(d) => { setDetail(d); onChanged(); }} />}
    </Modal>
  );
  return { open, element, show: setDetail };
}

/** Linha de devolução (fila e histórico). */
function Row({ r, onOpen }: { r: ReturnRowDto; onOpen: (id: string) => void }) {
  const item = r.items[0];
  const late = r.sellerDeadline && Date.parse(r.sellerDeadline) < Date.now() + 86_400_000;
  return (
    <button type="button" className="rt-row" onClick={() => onOpen(r.id)}>
      <ProductThumb src={item?.pictureUrl ?? null} alt={item?.name ?? ''} size={44} />
      <span className="rt-main">
        <b>{item?.name ?? 'Produto'}</b>
        <small>
          {item?.sku ?? '—'} · pedido {r.packId ?? r.orderId} · {RETURN_REASON_LABELS[r.reason]}
          {r.shipping ? ` · ${RETURN_SHIPPING_LABELS[r.shipping]}` : ''}
        </small>
      </span>
      <span className="rt-tags">
        <span className="rc-badge" data-status={r.status}>{RETURN_STATUS_LABELS[r.status]}</span>
        {r.pending.map((p) => <span key={p} className="rt-pend">{RETURN_PENDING_LABELS[p]}</span>)}
        {r.check && <span className="rt-class" data-class={r.check.class}>{r.check.class}</span>}
      </span>
      <span className="rt-num">
        <b>{r.loss === null ? '—' : money(r.loss)}</b>
        <small data-late={late || undefined}>{r.sellerDeadline ? `prazo ${dt(r.sellerDeadline)}` : `aberta ${dt(r.openedAt)}`}</small>
      </span>
    </button>
  );
}

function SyncBar({ summary, onSynced }: { summary: ReturnSummaryDto | null; onSynced: () => void }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  async function sync() {
    setBusy(true);
    setMsg('');
    try {
      await returnsApi.sync();
      setMsg('Buscando as devoluções no Mercado Livre… a lista atualiza sozinha.');
      const before = summary?.lastSync;
      for (let i = 0; i < 40; i++) {
        await new Promise((r) => setTimeout(r, 4000));
        const s = await returnsApi.summary().catch(() => null);
        if (s?.lastSync && s.lastSync !== before) {
          setMsg('Devoluções atualizadas.');
          break;
        }
      }
      onSynced();
    } catch (err) {
      setMsg(errMsg(err));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="rt-sync">
      <span>Atualiza sozinho de hora em hora · última: <b>{ago(summary?.lastSync ?? null)}</b></span>
      <button type="button" className="act" disabled={busy || summary?.connected === false} onClick={() => void sync()}>{busy ? 'Sincronizando…' : 'Sincronizar agora'}</button>
      {msg && <small>{msg}</small>}
    </div>
  );
}

// ================= Resumo
export function ReturnsSummaryView({ onGo }: { onGo: (status: string) => void }) {
  const [s, setS] = useState<ReturnSummaryDto | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => returnsApi.summary().then(setS).catch((e) => setError(errMsg(e))), []);
  const conf = useConference(() => void load());
  useEffect(() => {
    void load();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 60_000);
    return () => window.clearInterval(t);
  }, [load]);
  if (error) return <p className="banner banner-error">{error}</p>;
  if (!s) return <div className="promo-skel" aria-hidden="true" />;
  const hasData = Object.values(s.counts).some((n) => n > 0);
  if (!s.connected && !hasData) {
    return <div className="skus-empty"><strong>Conecte o Mercado Livre</strong><p>As devoluções vêm da conta conectada em Integrações.</p></div>;
  }
  const cards: { key: keyof ReturnSummaryDto['attention']; label: string; go: string; tone?: string }[] = [
    { key: 'awaitingCheck', label: 'Aguardando conferência', go: 'aguardando_conferencia' },
    { key: 'dispute', label: 'Para contestar no ML', go: 'precisa_acao', tone: 'bad' },
    { key: 'stock', label: 'Ajustar estoque', go: 'precisa_acao' },
    { key: 'manualTickets', label: 'Chamados manuais', go: 'precisa_acao' },
    { key: 'deadline24h', label: 'Prazo do ML em 24 h', go: 'precisa_acao,aguardando_conferencia', tone: 'bad' },
  ];
  return (
    <div className="rt">
      {!s.connected && <p className="banner banner-warn">A conta do Mercado Livre está desconectada: os dados abaixo são da última sincronização. Reconecte em Integrações.</p>}
      <SyncBar summary={s} onSynced={() => void load()} />
      <section className="rt-attn" aria-label="O que precisa de mão agora">
        {cards.map((c) => (
          <button key={c.key} type="button" className="rt-attn-card" data-tone={s.attention[c.key] ? c.tone : undefined} onClick={() => onGo(c.go)}>
            <b>{int(s.attention[c.key])}</b>
            <span>{c.label}</span>
          </button>
        ))}
      </section>
      <div className="full-two">
        <section className="full-box">
          <p className="full-kicker">A caminho da empresa</p>
          {(['aguardando_postagem', 'postado', 'sem_info'] as const).map((k) => (
            <p key={k} className="rt-line"><span>{RETURN_SHIPPING_LABELS[k]}</span><b>{int(s.onTheWay[k])}</b></p>
          ))}
          <button type="button" className="link" onClick={() => onGo('a_caminho')}>Ver as que estão a caminho →</button>
        </section>
        <section className="full-box">
          <p className="full-kicker">Por situação</p>
          {RETURN_STATUSES.map((st) => (
            <button key={st} type="button" className="rt-line rt-line-btn" onClick={() => onGo(st)}>
              <span>{RETURN_STATUS_LABELS[st]}</span><b>{int(s.counts[st])}</b>
            </button>
          ))}
        </section>
      </div>
      <section className="full-box">
        <p className="full-kicker">Últimas movimentações</p>
        {s.latest.length ? s.latest.map((r) => <Row key={r.id} r={r} onOpen={(id) => void conf.open(id)} />) : <p className="full-empty">Nenhuma devolução ainda. Clique em Sincronizar agora.</p>}
      </section>
      {conf.element}
    </div>
  );
}

// ================= Fila (operação) e Histórico
export function ReturnsListView({ initialStatus, history }: { initialStatus?: string; history?: boolean }) {
  const [status, setStatus] = useState(initialStatus ?? (history ? 'resolvida,finalizada' : ''));
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [data, setData] = useState<ReturnListDto | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(
    () => returnsApi.list({ status: status || (history ? 'resolvida,finalizada' : undefined), q, page }).then(setData).catch((e) => setError(errMsg(e))),
    [status, q, page, history],
  );
  const conf = useConference(() => void load());
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 200);
    return () => window.clearTimeout(t);
  }, [load]);
  const chips: ReturnStatus[] = history ? ['resolvida', 'finalizada'] : ['precisa_acao', 'aguardando_conferencia', 'a_caminho', 'em_mediacao', 'com_a_plataforma'];
  return (
    <div className="rt">
      <div className="rt-filters">
        <div className="full-chips" role="tablist" aria-label="Situação">
          <button type="button" role="tab" aria-checked={!status || status === 'resolvida,finalizada'} onClick={() => { setStatus(''); setPage(1); }}>Todas</button>
          {chips.map((c) => (
            <button key={c} type="button" role="tab" aria-checked={status === c} onClick={() => { setStatus(c); setPage(1); }}>
              {RETURN_STATUS_LABELS[c]} {data ? <em>{int(data.counts[c])}</em> : null}
            </button>
          ))}
        </div>
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }} placeholder="Pedido, rastreio, SKU ou produto…" />
        </label>
      </div>
      {error && <p className="banner banner-error">{error}</p>}
      {!data ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : (
        <section className="full-box">
          <p className="full-kicker">{int(data.total)} devolução(ões)</p>
          {data.items.map((r) => <Row key={r.id} r={r} onOpen={(id) => void conf.open(id)} />)}
          {!data.items.length && <p className="full-empty">Nada por aqui.</p>}
          {data.total > page * 30 && <button type="button" className="act load-more" onClick={() => setPage((p) => p + 1)}>Próxima página</button>}
          {page > 1 && <button type="button" className="link" onClick={() => setPage((p) => p - 1)}>‹ Página anterior</button>}
        </section>
      )}
      {conf.element}
    </div>
  );
}

// ================= B.I
export function ReturnsBiView() {
  const [days, setDays] = useState(30);
  const [bi, setBi] = useState<ReturnBiDto | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setBi(null);
    returnsApi.bi(days).then(setBi).catch((e) => setError(errMsg(e)));
  }, [days]);
  if (error) return <p className="banner banner-error">{error}</p>;
  const delta = (cur: number, prev: number) => (prev ? `${cur >= prev ? '+' : ''}${pct((cur - prev) / prev, 0)} vs. período anterior` : 'sem período anterior');
  const maxDay = Math.max(1, ...(bi?.series.map((s) => s.total) ?? []));
  return (
    <div className="rt">
      <div className="fpanel-head">
        <p className="ledit-hint">Devoluções abertas no período: quanto custaram (frete reverso + produto perdido), por que voltaram e o que se recuperou.</p>
        <div className="seg" role="tablist" aria-label="Período">
          {[7, 30, 90].map((d) => <button key={d} type="button" role="tab" aria-checked={days === d} onClick={() => setDays(d)}>{d} dias</button>)}
        </div>
      </div>
      {!bi ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : (
        <>
          <section className="full-kpis">
            <div className="full-kpi full-kpi-dark"><small>Devoluções</small><b>{int(bi.total)}</b><span>{delta(bi.total, bi.totalPrevious)}</span></div>
            <div className="full-kpi"><small>Custo total</small><b>{money(bi.money.totalCost)}</b><span>{delta(bi.money.totalCost, bi.moneyPrevious.totalCost)}</span></div>
            <div className="full-kpi"><small>Frete reverso</small><b>{money(bi.money.reverseFreight)}</b><span>{money(bi.money.freightInMediation)} em mediação</span></div>
            <div className="full-kpi"><small>Mercadoria perdida</small><b>{money(bi.money.productLoss)}</b><span>{bi.money.withoutCost ? `${bi.money.withoutCost} sem custo cadastrado` : 'pelo custo do SKU'}</span></div>
          </section>
          <div className="full-two">
            <section className="full-box">
              <p className="full-kicker">Por que voltaram</p>
              {bi.reasons.map((r) => (
                <div key={r.reason} className="full-dist">
                  <p><span>{RETURN_REASON_LABELS[r.reason]}</span><b>{int(r.qty)} ({r.pct}%)</b></p>
                  <span className="full-track"><i style={{ width: `${r.pct}%` }} /></span>
                </div>
              ))}
              {!bi.reasons.length && <p className="full-empty">Nenhuma devolução no período.</p>}
            </section>
            <section className="full-box">
              <p className="full-kicker">Mediações e conferência</p>
              <p className="rt-line"><span>Mediações ganhas</span><b>{int(bi.mediations.ganha)}</b></p>
              <p className="rt-line"><span>Perdidas</span><b>{int(bi.mediations.perdida)}</b></p>
              <p className="rt-line"><span>Parciais</span><b>{int(bi.mediations.parcial)}</b></p>
              <p className="rt-line"><span>Em andamento</span><b>{int(bi.mediations.em_andamento)}</b></p>
              <p className="rt-line"><span>Recuperado (estimado)</span><b>{money(bi.money.recovered)}</b></p>
              <p className="rt-line"><span>Conferidas: A vendável · B avaria · C divergente</span><b>{bi.classes.A} · {bi.classes.B} · {bi.classes.C}</b></p>
            </section>
          </div>
          <section className="full-box">
            <p className="full-kicker">Devoluções por dia</p>
            <div className="rt-bars">
              {bi.series.map((s) => (
                <span key={s.day} title={`${new Date(`${s.day}T12:00:00`).toLocaleDateString('pt-BR')}: ${s.total} (${s.resolved} resolvidas) · ${money(s.cost)}`}>
                  <i style={{ height: `${(s.total / maxDay) * 100}%` }} data-zero={s.total === 0 || undefined} />
                </span>
              ))}
            </div>
          </section>
          <section className="full-box">
            <p className="full-kicker">Produtos que mais voltam</p>
            {bi.products.map((p) => (
              <div key={`${p.sku}-${p.name}`} className="rt-prod">
                <ProductThumb src={p.pictureUrl} alt={p.name ?? ''} size={40} />
                <span className="rt-main"><b>{p.name ?? p.sku}</b><small>{p.sku ?? '—'}</small></span>
                <span className="rt-num"><b>{int(p.qty)}×</b><small>{money(p.loss)}</small></span>
              </div>
            ))}
            {!bi.products.length && <p className="full-empty">Nenhum produto no período.</p>}
          </section>
        </>
      )}
    </div>
  );
}

// ================= Bipe (Operação)
export function ReturnsScanView() {
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(null);
  const [notFound, setNotFound] = useState('');
  const [waiting, setWaiting] = useState<ReturnListDto | null>(null);
  const [choices, setChoices] = useState<ReturnDetailDto[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const loadWaiting = useCallback(() => returnsApi.list({ status: 'aguardando_conferencia,precisa_acao' }).then(setWaiting).catch(() => undefined), []);
  const conf = useConference(() => void loadWaiting());
  useEffect(() => {
    void loadWaiting();
    inputRef.current?.focus();
  }, [loadWaiting]);

  async function scan(raw: string, label?: string) {
    const c = raw.trim();
    if (!c) return;
    setCode('');
    setBusy(true);
    setMsg(null);
    try {
      const r = await returnsApi.find(c, label);
      if (!r.matches.length) {
        setNotFound(c);
        setMsg({ tone: 'warn', text: 'Não achei essa etiqueta. Digite o número do pedido (está na nota ou na etiqueta) para vincular.' });
      } else if (r.matches.length === 1) {
        setNotFound('');
        conf.show(r.matches[0]!);
      } else {
        setNotFound('');
        setChoices(r.matches);
      }
    } catch (err) {
      setMsg({ tone: 'error', text: errMsg(err) });
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  return (
    <div className="rt">
      <section className="full-box rt-scan">
        <p className="full-kicker">Central de devoluções · bancada</p>
        <h1>Bipe o pacote que voltou</h1>
        <p>Etiqueta, QR code, nota fiscal (DANFE), rastreio ou número do pedido — o que estiver no pacote.</p>
        <input
          ref={inputRef}
          className="full-scan"
          value={code}
          disabled={busy}
          autoComplete="off"
          placeholder={notFound ? 'Digite o nº do pedido…' : 'Bipe aqui…'}
          onChange={(e) => setCode(e.target.value)}
          // keyup: o leitor manda Enter no fim; abrir a conferência no keydown deixava o resto da tecla cair nela
          onKeyUp={(e) => e.key === 'Enter' && void scan(code, notFound || undefined)}
        />
        {msg && <p className={`banner banner-${msg.tone}`}>{msg.text}</p>}
        {notFound && <button type="button" className="link" onClick={() => { setNotFound(''); setMsg(null); }}>Cancelar vínculo de “{notFound}”</button>}
      </section>
      <section className="full-box">
        <p className="full-kicker">Na bancada: aguardando conferência ou com algo a fazer {waiting ? `(${int(waiting.total)})` : ''}</p>
        {waiting?.items.map((r) => <Row key={r.id} r={r} onOpen={(id) => void conf.open(id)} />)}
        {waiting && !waiting.items.length && <p className="full-empty">Nada esperando na bancada. 🎉</p>}
      </section>
      <Modal open={choices !== null} onClose={() => setChoices(null)} label="Qual devolução?" wide>
        {choices && (
          <div className="full-modal">
            <h2>Mais de uma devolução com esse código</h2>
            {choices.map((d) => <Row key={d.row.id} r={d.row} onOpen={() => { setChoices(null); conf.show(d); }} />)}
          </div>
        )}
      </Modal>
      {conf.element}
    </div>
  );
}
