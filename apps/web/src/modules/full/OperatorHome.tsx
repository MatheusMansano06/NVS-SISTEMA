import { useEffect, useRef, useState } from 'react';
import type { WmsFindCandidateDto, WmsListSummaryDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { usePerson } from '../operation/PersonContext';
import { fullApi } from './full-api';

type Note = { tone: 'error' | 'warn' | 'ok'; title: string; text: string };
const STATUS_LABEL: Record<string, string> = { pending: 'Pendente', in_progress: 'Em andamento', partial: 'Parcial', complete: 'Completo', out_of_stock: 'Sem estoque' };

const isToday = (iso: string | null) => Boolean(iso) && new Date(iso!).toDateString() === new Date().toDateString();

/** Painel de Operação: minhas listas, fila livre, concluídas hoje e a busca por código/SKU/título. */
export function OperatorHome({ onOpen }: { onOpen: (listId: string, sku?: string) => void }) {
  const me = usePerson()!.person.person;
  const [lists, setLists] = useState<WmsListSummaryDto[] | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<Note | null>(null);
  const [choices, setChoices] = useState<{ title: string; items: WmsFindCandidateDto[] } | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const load = () => fullApi.lists().then(setLists).catch(() => setLists([]));
  useEffect(() => {
    void load();
    inputRef.current?.focus();
    const t = window.setInterval(() => document.visibilityState === 'visible' && void load(), 30_000);
    return () => window.clearInterval(t);
  }, []);

  const flash = (tone: Note['tone'], title: string, text: string) => {
    setNote({ tone, title, text });
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
        flash('error', 'Transferência não feita', err instanceof ApiError ? err.message : 'Não foi possível transferir.');
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
      if (r.action === 'multiple') setChoices({ title: 'Selecione o item', items: r.candidates });
      else if ((r.action === 'open' || r.action === 'transfer_available') && r.match) await go(r.match);
      else if (r.action === 'already_done')
        flash('ok', 'Produto já recolhido!', `${r.sku} já foi separado${r.match ? ` por ${r.match.operatorName ?? '—'} na lista ${r.match.listCode}` : ''}.`);
      else if (r.action === 'in_progress_other')
        flash('warn', 'Com outro operador', `${r.sku} está sendo separado por ${r.match?.operatorName ?? 'outra pessoa'} na lista ${r.match?.listCode}.`);
      else if (r.action === 'not_in_lists') flash('error', 'Leitura sem demanda', `${r.sku} existe, mas não está em nenhuma lista aberta.`);
      else flash('error', 'Leitura não reconhecida', `Nada encontrado para “${code}”.`);
    } catch (err) {
      flash('error', 'Falha na busca', err instanceof ApiError ? err.message : 'Repita a leitura.');
    } finally {
      setBusy(false);
      inputRef.current?.focus();
    }
  }

  async function showPending() {
    setBusy(true);
    try {
      const items = await fullApi.pending();
      if (!items.length) flash('ok', 'Tudo separado', 'Nenhum SKU pendente nas listas abertas. 🎉');
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
      flash('error', 'Lista indisponível', err instanceof ApiError ? err.message : 'Não foi possível pegar a lista.');
      void load();
    }
  }

  const mine = lists?.filter((l) => l.operatorId === me.id && l.status !== 'completed') ?? [];
  const free = lists?.filter((l) => l.status === 'open' && !l.operatorId) ?? [];
  const done = lists?.filter((l) => l.operatorId === me.id && l.status === 'completed' && isToday(l.completedAt)) ?? [];

  return (
    <div className="oph">
      <section className="oph-head">
        <p className="oph-kicker">Painel de operação</p>
        <h1>Sessões em andamento</h1>
        <p>Gerencie suas listas de trabalho: retome as suas, pegue uma da fila ou bipe um produto para ir direto nele.</p>
      </section>

      <section className="oph-tiles" aria-label="Resumo">
        <div data-tone="blue"><small>Minhas ativas</small><b>{mine.length}</b></div>
        <div data-tone="gray"><small>Fila livre</small><b>{free.length}</b></div>
        <div data-tone="green"><small>Concluídas hoje</small><b>{done.length}</b></div>
      </section>

      <section className="oph-search">
        <label>
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></svg>
          <input
            ref={inputRef}
            value={q}
            disabled={busy}
            placeholder="EAN, SKU ou título p/ atalho mágico…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void search()}
            aria-label="Bipar ou buscar produto"
          />
        </label>
        <button type="button" className="oph-pending" onClick={() => void showPending()} disabled={busy}>
          <span aria-hidden="true" data-spin={busy || undefined}>⏳</span> SKU faltantes
        </button>
      </section>

      {note && (
        <div className="oph-note" data-tone={note.tone} role="status">
          <span aria-hidden="true">{note.tone === 'ok' ? '✓' : note.tone === 'warn' ? '🔒' : '✕'}</span>
          <div><b>{note.title}</b><p>{note.text}</p></div>
        </div>
      )}

      {!lists ? (
        <div className="oph-empty"><span aria-hidden="true">⏳</span><b>Carregando operações…</b></div>
      ) : (
        <>
          <Cards
            tone="blue"
            title="Minhas operações correntes"
            lists={mine}
            action="Retomar lista"
            onClick={(l) => onOpen(l.id)}
            empty={{ icon: '📋', title: 'Nenhuma lista ativa', text: 'Pegue uma lista na fila livre logo abaixo para começar a bipar.' }}
          />
          <Cards
            tone="gray"
            title="Fila livre"
            lists={free}
            action="Pegar lista"
            onClick={(l) => void take(l)}
            empty={{ icon: '📭', title: 'Fila vazia', text: 'Nenhuma lista nova esperando separação.' }}
          />
          {done.length > 0 && <Cards tone="green" title="Concluídas hoje" lists={done} action="Ver lista" onClick={(l) => onOpen(l.id)} />}
        </>
      )}

      <Modal open={choices !== null} onClose={() => setChoices(null)} label={choices?.title ?? 'Resultados'} wide>
        {choices && (
          <div className="oph-dialog">
            <header>
              <h2>{choices.title}</h2>
              <p>Escolha o item para ir direto na separação. Se estiver com outra pessoa e nada foi bipado, ele vem para você.</p>
            </header>
            <ul>
              {choices.items.map((c) => (
                <li key={c.itemId}>
                  <button type="button" onClick={() => void go(c)}>
                    <span className="oph-dialog-main">
                      <span className="oph-dialog-top">
                        <b>{c.sku}</b>
                        <em data-status={c.status}>{STATUS_LABEL[c.status] ?? c.status}</em>
                      </span>
                      <span className="oph-dialog-desc">{c.description}</span>
                      <span className="oph-dialog-meta">
                        <span><small>Lista</small><code>{c.listCode}</code></span>
                        {c.mlCode && <span><small>Código ML</small><code data-ml>{c.mlCode}</code></span>}
                        <span><small>Operador</small><b>{c.operatorName ?? 'Disponível'}</b></span>
                        <span><small>Qtd</small><b>{c.qtyPicked}/{c.qtyRequired}</b></span>
                      </span>
                    </span>
                    <span className="oph-arrow" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
            <button type="button" className="oph-cancel" onClick={() => setChoices(null)}>Cancelar</button>
          </div>
        )}
      </Modal>
    </div>
  );
}

type Tone = 'blue' | 'gray' | 'green';

function Cards({
  tone,
  title,
  lists,
  action,
  onClick,
  empty,
}: {
  tone: Tone;
  title: string;
  lists: WmsListSummaryDto[];
  action: string;
  onClick: (l: WmsListSummaryDto) => void;
  empty?: { icon: string; title: string; text: string };
}) {
  return (
    <section className="oph-sec" data-tone={tone}>
      <h2><i aria-hidden="true" />{title}</h2>
      {!lists.length ? (
        empty && (
          <div className="oph-empty">
            <span aria-hidden="true">{empty.icon}</span>
            <b>{empty.title}</b>
            <small>{empty.text}</small>
          </div>
        )
      ) : (
        <div className="oph-cards">
          {lists.map((l) => {
            const pct = l.itemsTotal ? Math.round((l.itemsPicked / l.itemsTotal) * 100) : 0;
            return (
              <button key={l.id} type="button" className="oph-card" onClick={() => onClick(l)}>
                <span className="oph-card-top">
                  <span className="full-ml" data-mp={l.marketplace} aria-hidden="true">{l.marketplace === 'shopee' ? 'S' : 'ML'}</span>
                  <span className="oph-card-id">
                    <b>{l.code}</b>
                    <em>{action}</em>
                    <small>{l.skuCount === 1 ? '1 SKU' : `${l.skuCount} SKUs`} · {int(l.itemsTotal)} un.</small>
                  </span>
                  <span className="oph-arrow" aria-hidden="true">{tone === 'green' ? '✓' : '→'}</span>
                </span>
                <span className="oph-prog">
                  <span><small>Progresso</small><b>{int(l.itemsPicked)}/{int(l.itemsTotal)}</b></span>
                  <span className="oph-track"><i style={{ width: `${pct}%` }} /></span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}
