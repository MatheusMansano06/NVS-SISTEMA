import { useEffect, useRef, useState } from 'react';
import type { WmsFindCandidateDto, WmsListSummaryDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { usePerson } from '../operation/PersonContext';
import { fullApi } from './full-api';

const isToday = (iso: string | null) => Boolean(iso) && new Date(iso!).toDateString() === new Date().toDateString();

/** Painel de Operação: minhas listas, fila livre, concluídas hoje e a busca por código/SKU/título. */
export function OperatorHome({ onOpen }: { onOpen: (listId: string, sku?: string) => void }) {
  const me = usePerson()!.person.person;
  const [lists, setLists] = useState<WmsListSummaryDto[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: 'error' | 'warn' | 'ok'; text: string } | null>(null);
  const [choices, setChoices] = useState<{ title: string; items: WmsFindCandidateDto[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => fullApi.lists().then(setLists).catch(() => setLists([]));
  useEffect(() => {
    void load();
    inputRef.current?.focus();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const flash = (tone: 'error' | 'warn' | 'ok', text: string) => {
    setNote({ tone, text });
    window.setTimeout(() => setNote((n) => (n?.text === text ? null : n)), 5000);
  };

  /** Abre o item: se for de outra pessoa (sem nada bipado), transfere para mim antes. */
  async function go(c: WmsFindCandidateDto) {
    setChoices(null);
    if (c.operatorName && c.operatorName !== me.name && c.qtyPicked === 0 && c.status === 'pending') {
      if (!window.confirm(`${c.sku} está na lista de ${c.operatorName}. Transferir para você e separar agora?`)) return;
      try {
        const t = await fullApi.transfer(c.itemId);
        onOpen(t.listId, c.sku);
      } catch (err) {
        flash('error', err instanceof ApiError ? err.message : 'Não foi possível transferir.');
      }
      return;
    }
    onOpen(c.listId, c.sku);
  }

  async function search() {
    const code = q.trim();
    if (!code) return;
    setQ('');
    setBusy(true);
    try {
      const r = await fullApi.find(code);
      if (r.action === 'multiple') setChoices({ title: `Resultados para “${code}”`, items: r.candidates });
      else if ((r.action === 'open' || r.action === 'transfer_available') && r.match) await go(r.match);
      else if (r.action === 'already_done') flash('ok', `${r.sku} já foi separado${r.match ? ` na lista ${r.match.listCode} (${r.match.operatorName ?? '—'})` : ''}.`);
      else if (r.action === 'in_progress_other') flash('warn', `${r.sku} está sendo separado por ${r.match?.operatorName ?? 'outra pessoa'} na lista ${r.match?.listCode}.`);
      else if (r.action === 'not_in_lists') flash('warn', `${r.sku} não está em nenhuma lista aberta.`);
      else flash('error', `Nada encontrado para “${code}”.`);
    } catch (err) {
      flash('error', err instanceof ApiError ? err.message : 'Erro na busca.');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function showPending() {
    setBusy(true);
    try {
      const items = await fullApi.pending();
      if (!items.length) flash('ok', 'Nenhum SKU pendente nas listas abertas. 🎉');
      else setChoices({ title: `SKUs faltando separar (${items.length})`, items });
    } finally {
      setBusy(false);
    }
  }

  async function take(l: WmsListSummaryDto) {
    try {
      await fullApi.claim(l.id);
      onOpen(l.id);
    } catch (err) {
      flash('error', err instanceof ApiError ? err.message : 'Não foi possível pegar a lista.');
      void load();
    }
  }

  const mine = lists?.filter((l) => l.operatorId === me.id && l.status !== 'completed') ?? [];
  const free = lists?.filter((l) => l.status === 'open' && !l.operatorId) ?? [];
  const done = lists?.filter((l) => l.operatorId === me.id && l.status === 'completed' && isToday(l.completedAt)) ?? [];

  return (
    <div className="full-op">
      <section className="full-box full-op-head">
        <p className="full-kicker">Painel de operação</p>
        <h1>Sessões em andamento</h1>
        <p>Pegue uma lista da fila ou bipe/busque um produto para ir direto nele.</p>
      </section>
      <section className="full-op-kpis">
        <div><small>Minhas ativas</small><b>{mine.length}</b></div>
        <div><small>Fila livre</small><b>{free.length}</b></div>
        <div><small>Concluídas hoje</small><b>{done.length}</b></div>
      </section>
      <section className="full-box full-op-search">
        <label className="search">
          <span aria-hidden="true">🔍</span>
          <input
            ref={inputRef}
            value={q}
            disabled={busy}
            placeholder="EAN, SKU ou título — atalho mágico…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
          />
        </label>
        <button type="button" className="full-dark-btn" onClick={() => void showPending()} disabled={busy}>⏳ SKU faltantes</button>
      </section>
      {note && <p className={`banner banner-${note.tone}`} role="status">{note.text}</p>}

      {!lists ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : (
        <>
          <Cards title="Minhas operações correntes" lists={mine} action="Retomar lista" onClick={(l) => onOpen(l.id)} empty="Você não tem lista em andamento." />
          <Cards title="Fila livre" lists={free} action="Pegar lista" onClick={(l) => void take(l)} empty="Nenhuma lista livre agora." />
          {done.length > 0 && <Cards title="Concluídas hoje" lists={done} action="Ver" onClick={(l) => onOpen(l.id)} empty="" />}
        </>
      )}

      <Modal open={choices !== null} onClose={() => setChoices(null)} label={choices?.title ?? 'Resultados'}>
        {choices && (
          <div className="full-modal">
            <h2>{choices.title}</h2>
            <ul className="full-choices">
              {choices.items.map((c) => (
                <li key={c.itemId}>
                  <button type="button" onClick={() => void go(c)}>
                    <span className="full-item-sku">
                      <b>{c.sku}</b>
                      <small>{c.description}</small>
                    </span>
                    <span className="full-choice-meta">
                      <span className="full-code">{c.listCode}</span>
                      <small>{c.operatorName ?? 'Disponível'} · {c.qtyPicked}/{c.qtyRequired}</small>
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Modal>
    </div>
  );
}

function Cards({ title, lists, action, onClick, empty }: { title: string; lists: WmsListSummaryDto[]; action: string; onClick: (l: WmsListSummaryDto) => void; empty: string }) {
  return (
    <section className="full-op-sec">
      <h2 className="full-h2">● {title}</h2>
      {!lists.length ? (
        <p className="full-empty">{empty}</p>
      ) : (
        <div className="full-op-cards">
          {lists.map((l) => {
            const pct = l.itemsTotal ? Math.round((l.itemsPicked / l.itemsTotal) * 100) : 0;
            return (
              <button key={l.id} type="button" className="full-op-card" onClick={() => onClick(l)}>
                <span className="full-ml" aria-hidden="true">ML</span>
                <span className="full-op-card-main">
                  <b>{l.code}</b>
                  <em>{action} →</em>
                  <small>{l.skuCount === 1 ? '1 SKU' : `${l.skuCount} SKUs`} · {int(l.itemsTotal)} un.</small>
                </span>
                <span className="full-op-card-prog">
                  <span><small>Progresso</small><b>{int(l.itemsPicked)}/{int(l.itemsTotal)}</b></span>
                  <span className="full-track" data-tone={pct === 100 ? 'ok' : 'blue'}><i style={{ width: `${pct}%` }} /></span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
