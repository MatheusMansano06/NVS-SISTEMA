import { useEffect, useState } from 'react';
import type { WmsMarketplace, WmsShortageDto } from '@nvs/shared';
import { int } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { Modal } from '../../shared/ui/Modal';
import { fullApi } from './full-api';

type Filtro = 'pendente' | 'concluido' | 'todas';
const GRUPOS: { mp: WmsMarketplace; titulo: string; texto: string }[] = [
  { mp: 'ml', titulo: 'Mercado Livre Full', texto: 'Faltas nas listas de envio para o Full do Mercado Livre' },
  { mp: 'shopee', titulo: 'Shopee Full', texto: 'Faltas nas listas de envio para o Full da Shopee' },
];
const quando = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—';

/**
 * Relatório de Faltas (portado do NVS-WMS): tudo que o picking não achou inteiro — "achei menos", "sem estoque" ou
 * caixa incompleta — por marketplace, com quem marcou, quando e a observação. Marque como resolvida quando repuser.
 */
export function ShortageReport({ onOpenList }: { onOpenList: (listId: string, sku: string) => void }) {
  const [rows, setRows] = useState<WmsShortageDto[] | null>(null);
  const [filtro, setFiltro] = useState<Filtro>('pendente');
  const [fechados, setFechados] = useState<Partial<Record<WmsMarketplace, boolean>>>({});
  const [apagarTudo, setApagarTudo] = useState(false);
  const [erro, setErro] = useState('');

  const load = () => fullApi.shortages().then(setRows).catch((e) => { setRows([]); setErro(e instanceof ApiError ? e.message : 'Não foi possível carregar.'); });
  useEffect(() => { void load(); }, []);

  const pendentes = (rows ?? []).filter((r) => r.status === 'pendente');
  const visiveis = (rows ?? []).filter((r) => filtro === 'todas' || r.status === filtro);

  async function alternar(r: WmsShortageDto) {
    const status = r.status === 'pendente' ? 'concluido' : 'pendente';
    setRows((rs) => rs?.map((x) => (x.itemId === r.itemId ? { ...x, status } : x)) ?? null);
    await fullApi.shortageStatus(r.itemId, status).catch(() => void load());
  }
  async function remover(r: WmsShortageDto) {
    if (!window.confirm(`Tirar a falta do ${r.sku} (lista ${r.listCode}) do relatório? O registro do picking continua.`)) return;
    setRows((rs) => rs?.filter((x) => x.itemId !== r.itemId) ?? null);
    await fullApi.removeShortage(r.itemId).catch(() => void load());
  }

  return (
    <div className="fr">
      <section className="fr-head">
        <div>
          <h2>Relatório de Faltas</h2>
          <p>Tudo que não foi encontrado inteiro durante a separação. Quando repor ou resolver, marque como resolvida.</p>
        </div>
        <div className="fr-total" data-zero={pendentes.length === 0 || undefined}>
          <small>Pendentes</small>
          <b>{int(pendentes.reduce((s, r) => s + r.qty, 0))} <span>unidades</span></b>
          <em>{pendentes.length} {pendentes.length === 1 ? 'item' : 'itens'}</em>
        </div>
      </section>

      <div className="fr-bar">
        <div className="seg" role="tablist" aria-label="Situação">
          {(['pendente', 'concluido', 'todas'] as const).map((f) => (
            <button key={f} type="button" role="tab" aria-checked={filtro === f} onClick={() => setFiltro(f)}>
              {f === 'pendente' ? 'Pendentes' : f === 'concluido' ? 'Resolvidas' : 'Todas'}
              <span>{(rows ?? []).filter((r) => f === 'todas' || r.status === f).length}</span>
            </button>
          ))}
        </div>
        {(rows?.length ?? 0) > 0 && <button type="button" className="act act-danger" onClick={() => setApagarTudo(true)}>Limpar relatório</button>}
      </div>

      {erro && <p className="banner banner-error">{erro}</p>}
      {!rows ? (
        <div className="promo-skel" aria-hidden="true" />
      ) : !rows.length ? (
        <div className="fr-empty"><span aria-hidden="true">🎉</span><strong>Tudo em dia!</strong><p>Nenhuma falta registrada no picking.</p></div>
      ) : (
        GRUPOS.map((g) => {
          const itens = visiveis.filter((r) => r.marketplace === g.mp);
          const pend = itens.filter((r) => r.status === 'pendente');
          const aberto = !fechados[g.mp];
          return (
            <section key={g.mp} className="fr-group" data-mp={g.mp}>
              <button type="button" className="fr-group-head" aria-expanded={aberto} onClick={() => setFechados((f) => ({ ...f, [g.mp]: aberto }))}>
                <span className="fr-mp" aria-hidden="true">{g.mp === 'ml' ? 'ML' : 'S'}</span>
                <span className="fr-group-title"><strong>{g.titulo}</strong><small>{g.texto}</small></span>
                <span className="fr-group-num"><b>{int(pend.reduce((s, r) => s + r.qty, 0))}</b><small>un. pendentes · {itens.length} itens</small></span>
                <span className="fr-chev" aria-hidden="true">{aberto ? '−' : '+'}</span>
              </button>
              {aberto && (itens.length === 0 ? (
                <p className="fr-none">Nada aqui {filtro === 'pendente' ? 'pendente' : filtro === 'concluido' ? 'resolvido' : ''}.</p>
              ) : (
                <ul className="fr-list">
                  {itens.map((r) => (
                    <li key={r.itemId} className="fr-row" data-done={r.status === 'concluido' || undefined}>
                      <span className="fr-sku"><b>{r.sku}</b><small title={r.description}>{r.description || 'Sem descrição cadastrada'}</small></span>
                      <button type="button" className="fr-list-code" title="Abrir a lista no item" onClick={() => onOpenList(r.listId, r.sku)}>
                        {r.listCode}{r.batchName ? <small>{r.batchName}</small> : null}
                      </button>
                      <span className="fr-who"><i aria-hidden="true">{(r.operatorName ?? '?').charAt(0).toUpperCase()}</i><span>{r.operatorName ?? '—'}<small>{quando(r.at)}</small></span></span>
                      <span className="fr-note" title={r.notes ?? undefined}>{r.notes ?? <em>sem observação</em>}</span>
                      <b className="fr-qty">−{int(r.qty)}<small> un.</small></b>
                      <button type="button" className="fr-status" data-status={r.status} onClick={() => void alternar(r)} title="Clique para alternar">
                        {r.status === 'concluido' ? '✓ Resolvida' : 'Pendente'}
                      </button>
                      <button type="button" className="fr-del" onClick={() => void remover(r)} aria-label={`Tirar ${r.sku} do relatório`}>✕</button>
                    </li>
                  ))}
                </ul>
              ))}
            </section>
          );
        })
      )}

      <Modal open={apagarTudo} onClose={() => setApagarTudo(false)} label="Limpar relatório">
        <div className="full-modal">
          <h2>Limpar o relatório de faltas?</h2>
          <p>Os {rows?.length ?? 0} registros saem do relatório. O que foi separado e as listas continuam iguais.</p>
          <div className="full-modal-acts">
            <button type="button" className="act" onClick={() => setApagarTudo(false)} data-autofocus>Cancelar</button>
            <button type="button" className="full-dark-btn full-danger-btn" onClick={() => void fullApi.removeAllShortages().then(() => { setApagarTudo(false); void load(); })}>
              Sim, limpar
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
