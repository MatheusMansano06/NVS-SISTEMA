import { useEffect, useState, type KeyboardEvent } from 'react';
import { marginTone as tone, type ListingDto } from '@nvs/shared';
import { int, money, pct } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { listingsApi } from './listings-api';
import type { EditorTab } from './ListingEditorModal';

const EDIT: [EditorTab, string][] = [
  ['description', 'Descrição'],
  ['pictures', 'Fotos'],
  ['attributes', 'Ficha técnica'],
  ['dimensions', 'Dimensões'],
  ['wholesale', 'Atacado B2B'],
  ['flex', 'Flex'],
];

const LOGISTIC: Record<ListingDto['logistic'], { label: string; hint: string }> = {
  full: { label: 'Full', hint: 'ML armazena e envia' },
  flex: { label: 'Flex', hint: 'você envia no mesmo dia' },
  agency: { label: 'Agência', hint: 'postagem em agência' },
  collect: { label: 'Coleta', hint: 'coleta agendada pelo ML' },
  standard: { label: 'Padrão', hint: 'Mercado Envios' },
};

const STATUS_LABEL: Record<string, string> = {
  active: 'Ativo',
  paused: 'Pausado',
  closed: 'Finalizado',
  under_review: 'Em revisão',
  inactive: 'Inativo',
};

function age(iso: string | null): string | null {
  if (!iso) return null;
  const days = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000));
  if (days === 0) return 'criado hoje';
  if (days === 1) return 'criado há 1 dia';
  return `criado há ${days.toLocaleString('pt-BR')} dias`;
}

interface Props {
  item: ListingDto;
  canManage: boolean;
  onChanged: (patch: Partial<ListingDto>) => void;
  onPricing: () => void;
  onSales: () => void;
  onEdit: (tab: EditorTab) => void;
  onDuplicate: () => void;
  onMsg: (kind: 'ok' | 'error', text: string) => void;
}

/** Cartão de anúncio: foto, preço/margem, métricas e ações no mesmo lugar. */
export function ListingCard({ item, canManage, onChanged, onPricing, onSales, onEdit, onDuplicate, onMsg }: Props) {
  const [stock, setStock] = useState(item.stock === null ? '' : String(item.stock));
  const [busy, setBusy] = useState<'stock' | 'status' | 'delete' | null>(null);
  useEffect(() => setStock(item.stock === null ? '' : String(item.stock)), [item.stock]);

  const full = item.logistic === 'full';
  const closed = item.status === 'closed';
  const m = item.margin;

  async function saveStock() {
    const n = Number(stock);
    if (stock === '' || !Number.isInteger(n) || n < 0) {
      setStock(item.stock === null ? '' : String(item.stock));
      return;
    }
    if (n === item.stock) return;
    setBusy('stock');
    try {
      await listingsApi.setStock(item.id, n);
      onChanged({ stock: n });
      onMsg('ok', `Estoque de ${item.sku ?? item.id} atualizado para ${n}.`);
    } catch (err) {
      setStock(item.stock === null ? '' : String(item.stock));
      onMsg('error', err instanceof ApiError ? err.message : 'Não foi possível atualizar o estoque.');
    } finally {
      setBusy(null);
    }
  }

  async function changeStatus(status: 'active' | 'paused' | 'closed') {
    if (status === 'closed' && !window.confirm('Finalizar este anúncio? Isso é IRREVERSÍVEL no Mercado Livre.')) return;
    if (status === 'paused' && !window.confirm('Pausar este anúncio no Mercado Livre?')) return;
    setBusy('status');
    try {
      await listingsApi.setStatus(item.id, status);
      onChanged({ status });
      onMsg('ok', status === 'active' ? 'Anúncio reativado.' : status === 'paused' ? 'Anúncio pausado.' : 'Anúncio finalizado.');
    } catch (err) {
      onMsg('error', err instanceof ApiError ? err.message : 'Não foi possível alterar o status.');
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm('Excluir este anúncio? Ele é finalizado e some da sua lista (o ML guarda o histórico). Não dá para desfazer.')) return;
    setBusy('delete');
    try {
      await listingsApi.remove(item.id);
      onChanged({ status: 'closed' });
      onMsg('ok', 'Anúncio excluído.');
    } catch (err) {
      onMsg('error', err instanceof ApiError ? err.message : 'Não foi possível excluir.');
    } finally {
      setBusy(null);
    }
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') e.currentTarget.blur();
    if (e.key === 'Escape') {
      setStock(item.stock === null ? '' : String(item.stock));
      e.currentTarget.blur();
    }
  }

  const lg = LOGISTIC[item.logistic];
  const created = age(item.listedAt);

  return (
    <article className="lcard" data-status={item.status}>
      <div className="lcard-media">
        <ProductThumb src={item.pictureUrl} alt={item.title} />
        <div className="lcard-badges">
          <span className={`tag tag-${item.status === 'active' ? 'active' : 'paused'}`}>
            {STATUS_LABEL[item.status] ?? item.status}
          </span>
          {full && <span className="tag tag-full">FULL</span>}
          {item.logistic === 'flex' && <span className="tag tag-flex">FLEX</span>}
          {item.catalog && <span className="tag tag-cat">Catálogo</span>}
        </div>
      </div>

      <div className="lcard-body">
        <header className="lcard-head">
          <strong className="lcard-sku" title={item.sku ?? item.id}>{item.sku ?? item.id}</strong>
          <h3 title={item.title}>{item.title}</h3>
          <p className="lcard-meta">
            {item.type && <span className="tag tag-type">{item.type}</span>}
            <a href={item.permalink ?? undefined} target="_blank" rel="noreferrer">{item.id}</a>
            {created && <span>{created}</span>}
            {item.freeShipping && <span className="lcard-free">frete grátis</span>}
          </p>
        </header>

        <div className="lcard-price">
          <div>
            <small>{item.originalPrice !== null ? 'Preço com desconto' : 'Preço'}</small>
            {item.originalPrice !== null && item.price !== null && (
              <span className="lcard-was" title={item.promoName ?? undefined}>
                <s>{money(item.originalPrice)}</s>
                <span className="tag tag-off">−{Math.round((1 - item.price / item.originalPrice) * 100)}%</span>
              </span>
            )}
            <b>{item.price === null ? '—' : money(item.price)}</b>
          </div>
          <div className="lcard-mc" data-tone={tone(m.pct)} title={m.source === 'sales' ? 'Estimativa com a média das vendas dos últimos 90 dias' : undefined}>
            <span>
              <small>MC R$</small>
              <b>{m.amount === null ? '—' : money(m.amount)}</b>
            </span>
            <span>
              <small>MC %</small>
              <b>{m.pct === null ? '—' : pct(m.pct, 2)}</b>
            </span>
          </div>
        </div>
        <p className="lcard-cost">
          {item.cost === null ? (
            <button type="button" className="chip chip-warn" onClick={onPricing}>Sem custo — cadastrar</button>
          ) : (
            <button type="button" className="chip" onClick={onPricing}>custo <b>{money(item.cost)}</b></button>
          )}
          {item.feeBonus !== null && item.feeBonus > 0 && (
            <span
              className="chip chip-bonus"
              title={`${item.promoName ? `Campanha “${item.promoName}”: ` : ''}o ML banca parte do desconto e devolve esse valor da tarifa a cada venda.`}
            >
              bônus ML <b>+{money(item.feeBonus)}</b>/venda
            </span>
          )}
          {m.source === 'sales' && m.amount !== null && <span className="lcard-est">margem estimada pelas vendas</span>}
          {m.amount === null && item.cost !== null && <span className="lcard-est">abra “Preço e margem” para calcular</span>}
        </p>

        <dl className="lcard-stats">
          <div>
            <dt>Estoque</dt>
            <dd>
              <input
                className="stock-input"
                inputMode="numeric"
                value={stock}
                disabled={!canManage || full || closed || busy === 'stock'}
                aria-label={`Estoque de ${item.sku ?? item.id}`}
                onChange={(e) => setStock(e.target.value.replace(/\D/g, ''))}
                onBlur={() => void saveStock()}
                onKeyDown={onKey}
              />
              {full && <small>Full (ML gere)</small>}
            </dd>
          </div>
          <div>
            <dt>Vendidos</dt>
            <dd>
              <b>{item.sold === null ? '—' : int(item.sold)}</b>
              <button type="button" className="mini" onClick={onSales} aria-label="Ver vendas deste anúncio na aba Vendas" title="Ver vendas deste anúncio na aba Vendas">
                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
              </button>
            </dd>
          </div>
          <div>
            <dt>Frete</dt>
            <dd>
              <b>{m.freight === null ? (item.freeShipping ? 'grátis' : 'comprador') : money(m.freight)}</b>
              <small>{item.freeShipping ? 'subsídio do vendedor' : 'por conta do comprador'}</small>
            </dd>
          </div>
          <div>
            <dt>Logística</dt>
            <dd><b>{lg.label}</b><small>{lg.hint}</small></dd>
          </div>
          <div>
            <dt>Imagens</dt>
            <dd>
              <b>{item.picturesCount === null ? '—' : `${item.picturesCount} ${item.picturesCount === 1 ? 'foto' : 'fotos'}`}</b>
              <small>{item.picturesCount !== null && item.picturesCount < 3 ? 'recomendado: 3+' : 'cadastradas'}</small>
            </dd>
          </div>
          <div>
            <dt>Dimensões</dt>
            <dd>
              <b>{item.dimensions ?? '—'}</b>
              <small>{full ? 'medido pelo ML (Full)' : item.dimensions ? 'declarado pelo vendedor' : 'não informado'}</small>
            </dd>
          </div>
        </dl>

        {!closed && (
          <nav className="lcard-edit" aria-label="Editar anúncio">
            {EDIT.map(([tab, label]) => (
              <button key={tab} type="button" onClick={() => onEdit(tab)}>{label}</button>
            ))}
          </nav>
        )}

        <footer className="lcard-actions">
          <button type="button" className="act act-strong" onClick={onPricing}>Preço e margem</button>
          {canManage && !closed && item.status === 'active' && (
            <button type="button" className="act" disabled={busy === 'status'} onClick={() => void changeStatus('paused')}>Pausar</button>
          )}
          {canManage && !closed && item.status !== 'active' && (
            <button type="button" className="act" disabled={busy === 'status'} onClick={() => void changeStatus('active')}>Reativar</button>
          )}
          <details className="lmenu">
            <summary className="act" aria-label="Mais ações">Mais ⋯</summary>
            <div className="lmenu-pop" role="menu">
              {item.permalink && (
                <a role="menuitem" href={item.permalink} target="_blank" rel="noreferrer">Ver no Mercado Livre</a>
              )}
              {canManage && (
                <button type="button" role="menuitem" onClick={onDuplicate}>
                  Duplicar anúncio <small>cria uma cópia pausada, na mesma ou em outra categoria</small>
                </button>
              )}
              {canManage && !closed && (
                <button type="button" role="menuitem" className="danger" disabled={busy !== null} onClick={() => void changeStatus('closed')}>
                  Finalizar <small>encerra as vendas; não dá para reativar</small>
                </button>
              )}
              {canManage && (
                <button type="button" role="menuitem" className="danger" disabled={busy !== null} onClick={() => void remove()}>
                  Excluir <small>finaliza e tira da lista</small>
                </button>
              )}
            </div>
          </details>
        </footer>
      </div>
    </article>
  );
}
