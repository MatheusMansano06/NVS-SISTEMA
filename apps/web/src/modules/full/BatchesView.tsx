import { useCallback, useEffect, useState } from 'react';
import { WMS_ITEM_STATUS_LABELS, type WmsBatchDto, type WmsItemDto, type WmsListSummaryDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { usePerson } from '../operation/PersonContext';
import { fullApi } from './full-api';

const errMsg = (err: unknown) => (err instanceof ApiError ? err.message : 'Não foi possível concluir.');
const PHASE: Record<WmsBatchDto['lifecycle'], string> = { pendente: 'Pendente', em_andamento: 'Em andamento', finalizado: 'Finalizado' };

/** Quem pode mexer em lotes/listas (arquivar, apagar, liberar): Análise ou MASTER. */
export function useSupervisor() {
  const p = usePerson()?.person.person;
  const mode = usePerson()?.person.mode;
  return mode === 'analise' || Boolean(p?.master);
}

/** Listas e Lotes: lotes ativos, arquivados e listas avulsas (transferências). */
export function BatchesView({ onOpenBatch, onOpenList }: { onOpenBatch: (id: string) => void; onOpenList?: (id: string) => void }) {
  const [data, setData] = useState<{ batches: WmsBatchDto[]; loose: WmsListSummaryDto[] } | null>(null);
  const [error, setError] = useState('');
  const sup = useSupervisor();
  const load = useCallback(() => fullApi.batches().then(setData).catch((e) => setError(errMsg(e))), []);
  useEffect(() => void load(), [load]);

  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      await load();
    } catch (e) {
      setError(errMsg(e));
    }
  };

  if (!data) return error ? <p className="banner banner-error">{error}</p> : <div className="promo-skel" aria-hidden="true" />;
  const active = data.batches.filter((b) => b.status === 'active');
  const archived = data.batches.filter((b) => b.status === 'archived');
  return (
    <div className="full-batches">
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      {!data.batches.length && !data.loose.length && (
        <div className="skus-empty">
          <strong>Nenhum lote ainda</strong>
          <p>Os lotes nascem do PDF do envio Full carregado em Processamento.</p>
        </div>
      )}
      {active.length > 0 && (
        <section>
          <h2 className="full-h2">📁 Lotes ativos</h2>
          <div className="full-batch-grid">
            {active.map((b) => {
              const n = (s: WmsListSummaryDto['status']) => b.lists.filter((l) => l.status === s).length;
              return (
                <article key={b.id} className="full-batch" onClick={() => onOpenBatch(b.id)} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onOpenBatch(b.id)}>
                  <header>
                    <div>
                      <strong>{b.name}</strong>
                      <small>
                        {b.lists.length} {b.lists.length === 1 ? 'lista' : 'listas'} · {int(b.totalItems)} unidades{b.inboundRef ? ` · envio #${b.inboundRef}` : ''}
                      </small>
                    </div>
                    <b className="full-batch-pct">{b.pct}%</b>
                  </header>
                  <span className="full-track" data-tone={b.pct >= 90 ? 'ok' : b.pct >= 50 ? 'blue' : 'warn'}>
                    <i style={{ width: `${b.pct}%` }} />
                  </span>
                  <div className="full-badges">
                    <span className="full-badge" data-phase={b.lifecycle}>{PHASE[b.lifecycle]}</span>
                    {n('in_progress') > 0 && <span className="full-badge" data-tone="blue">Ativas {n('in_progress')}</span>}
                    {n('open') > 0 && <span className="full-badge">Abertas {n('open')}</span>}
                    {n('completed') > 0 && <span className="full-badge" data-tone="ok">Concluídas {n('completed')}</span>}
                  </div>
                  <footer>
                    <span>{int(b.totalPicked)} / {int(b.totalItems)}</span>
                    <span className="full-link">Supervisionar →</span>
                  </footer>
                  {sup && (
                    <div className="full-batch-actions" onClick={(e) => e.stopPropagation()}>
                      {b.lifecycle === 'em_andamento' && (
                        <button type="button" className="act" onClick={() => window.confirm(`Marcar o lote ${b.name} como finalizado?`) && void act(() => fullApi.lifecycle(b.id, 'finalizado'))}>
                          Finalizar
                        </button>
                      )}
                      {b.lifecycle === 'finalizado' && (
                        <button type="button" className="act" onClick={() => void act(() => fullApi.lifecycle(b.id, 'em_andamento'))}>Reabrir</button>
                      )}
                      <button type="button" className="act" onClick={() => void act(() => fullApi.archive(b.id, true))}>Arquivar</button>
                      <button
                        type="button"
                        className="act act-danger"
                        onClick={() => window.confirm(`Apagar o lote ${b.name}? Todas as listas, bipagens e etiquetas dele somem. Não dá para desfazer.`) && void act(() => fullApi.deleteBatch(b.id))}
                      >
                        Apagar
                      </button>
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      )}

      {data.loose.length > 0 && (
        <section>
          <h2 className="full-h2">⚠️ Listas avulsas</h2>
          <div className="full-box">
            {data.loose.map((l) => <ListRow key={l.id} list={l} onChanged={() => void load()} onOpen={onOpenList} />)}
          </div>
        </section>
      )}

      {archived.length > 0 && (
        <section>
          <h2 className="full-h2 full-h2-muted">🗂️ Lotes arquivados</h2>
          <div className="full-archived">
            {archived.map((b) => (
              <article key={b.id} onClick={() => onOpenBatch(b.id)} role="button" tabIndex={0}>
                <span className="full-badge">Arquivado</span>
                <strong>{b.name}</strong>
                <small>{b.lists.length} listas · {b.pct}%</small>
                {sup && (
                  <button type="button" className="act" onClick={(e) => { e.stopPropagation(); void act(() => fullApi.archive(b.id, false)); }}>
                    Desarquivar
                  </button>
                )}
              </article>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}

/** Detalhe de um lote: todas as listas, com os SKUs de cada uma. */
export function BatchDetail({ id, onBack, onOpenList }: { id: string; onBack: () => void; onOpenList?: (id: string) => void }) {
  const [b, setB] = useState<WmsBatchDto | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(() => fullApi.batch(id).then(setB).catch((e) => setError(errMsg(e))), [id]);
  useEffect(() => void load(), [load]);
  if (!b) return error ? <p className="banner banner-error">{error}</p> : <div className="promo-skel" aria-hidden="true" />;
  return (
    <div className="full-batches">
      <button type="button" className="link full-back" onClick={onBack}>‹ Listas e Lotes</button>
      <section className="full-hero full-hero-sm">
        <div className="full-hero-top">
          <div>
            <p className="full-kicker">Lote · {PHASE[b.lifecycle]}{b.status === 'archived' ? ' · arquivado' : ''}</p>
            <p className="full-hero-pct"><b>{b.name}</b> <span>{int(b.totalPicked)} / {int(b.totalItems)} unidades{b.inboundRef ? ` · envio #${b.inboundRef}` : ''}</span></p>
          </div>
          <div className="full-rate"><small>Concluído</small><b>{b.pct}%</b></div>
        </div>
        <div className="full-bar"><i style={{ width: `${b.pct}%` }} /></div>
      </section>
      {error && <p className="banner banner-error">{error}</p>}
      <div className="full-box">
        {b.lists.map((l) => <ListRow key={l.id} list={l} onChanged={() => void load()} onOpen={onOpenList} />)}
      </div>
    </div>
  );
}

/** Uma lista: código, dono, progresso; abre os SKUs (com observação) e ações de supervisor. */
export function ListRow({ list, onChanged, onOpen }: { list: WmsListSummaryDto; onChanged: () => void; onOpen?: (id: string) => void }) {
  const [items, setItems] = useState<WmsItemDto[] | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState('');
  const sup = useSupervisor();
  const pct = list.itemsTotal ? Math.round((list.itemsPicked / list.itemsTotal) * 100) : 0;
  const toggle = async () => {
    setOpen(!open);
    if (!open && !items) setItems((await fullApi.list(list.id).catch(() => null))?.items ?? []);
  };
  const act = async (fn: () => Promise<unknown>) => {
    setError('');
    try {
      await fn();
      onChanged();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  return (
    <div className="full-row" data-open={open || undefined}>
      <div className="full-row-main">
        <span className="full-code">{list.code}</span>
        <span className="full-owner">
          {list.operatorName ? <><i aria-hidden="true">{list.operatorName.charAt(0)}</i>{list.operatorName}</> : <em>—</em>}
        </span>
        <span className="full-row-prog">
          <span className="full-track" data-tone={pct === 100 ? 'ok' : 'blue'}><i style={{ width: `${pct}%` }} /></span>
          <b>{int(list.itemsPicked)}/{int(list.itemsTotal)}</b>
        </span>
        <span className="full-badge" data-status={list.status}>
          {list.status === 'completed' ? 'Concluída' : list.status === 'in_progress' ? 'Em andamento' : 'Disponível'}
        </span>
        <span className="full-row-acts">
          <button type="button" className="act" onClick={() => void toggle()}>{open ? 'Ocultar' : `Ver SKUs (${list.skuCount})`}</button>
          {onOpen && <button type="button" className="act act-strong" onClick={() => onOpen(list.id)}>Abrir</button>}
          {sup && list.operatorId && (
            <button type="button" className="act" onClick={() => window.confirm(`Liberar ${list.code}? Sai de ${list.operatorName} e volta para a fila (o que já foi bipado fica).`) && void act(() => fullApi.release(list.id))}>
              Liberar
            </button>
          )}
          {sup && (
            <button type="button" className="act act-danger" aria-label={`Apagar ${list.code}`} onClick={() => window.confirm(`Apagar a lista ${list.code}? Não dá para desfazer.`) && void act(() => fullApi.deleteList(list.id))}>
              🗑
            </button>
          )}
        </span>
      </div>
      {error && <p className="sku-error">{error}</p>}
      {open && (
        <div className="full-items">
          {!items ? (
            <div className="promo-skel full-rank-skel" aria-hidden="true" />
          ) : (
            items.map((i) => (
              <div key={i.id} className="full-item">
                <ProductThumb src={i.pictureUrl} alt={i.description} size={36} />
                <span className="full-item-sku">
                  <b>{i.sku}</b>
                  <small>{i.mlCode ?? '—'} · {i.description}</small>
                </span>
                <span className="full-item-qty">{i.qtyPicked} / {i.qtyRequired}</span>
                <span className="full-badge" data-item={i.status}>{WMS_ITEM_STATUS_LABELS[i.status]}</span>
                <button
                  type="button"
                  className="full-note"
                  title="Observação"
                  onClick={async () => {
                    const v = window.prompt(`Observação para ${i.sku}`, i.notes ?? '');
                    if (v === null) return;
                    await fullApi.notes(i.id, v.trim() || null).catch(() => undefined);
                    setItems((prev) => prev?.map((x) => (x.id === i.id ? { ...x, notes: v.trim() || null } : x)) ?? null);
                  }}
                >
                  {i.notes || <em>sem observação</em>}
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}

/** Relatório de faltas (itens com falta nas listas dos lotes ativos). */
