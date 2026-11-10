import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import type { SkuRowDto } from '@nvs/shared';
import { normalizeBrNumber } from '../../shared/br-number';
import { int, money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { PLATFORM_LABELS } from './platforms';
import { skusApi } from './skus-api';

const toInput = (n: number | null) => (n === null ? '' : n.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const parse = (s: string): number | null => {
  const t = normalizeBrNumber(s);
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : NaN;
};

type State = 'idle' | 'saving' | 'saved' | 'error';

/** Linha editável: salva sozinha ao sair do campo ou com Enter; Esc desfaz. */
export function SkuRow({
  row,
  onSaved,
  platforms,
  onLink,
  onChanged,
}: {
  row: SkuRowDto;
  onSaved: (sku: string, custo: number) => void;
  /** Mostra as plataformas e o vínculo entre SKUs (empresa com mais de um marketplace). */
  platforms?: boolean;
  onLink?: (row: SkuRowDto) => void;
  onChanged?: () => void;
}) {
  const [custo, setCusto] = useState(toInput(row.custoUnit));
  const [state, setState] = useState<State>('idle');
  const [error, setError] = useState('');

  useEffect(() => setCusto(toInput(row.custoUnit)), [row.custoUnit]);

  const linked = Boolean(row.linkedSku);
  // custo acima do preço de venda costuma ser erro de digitação: só grava se a pessoa confirmar o mesmo valor
  const warned = useRef<{ value: number; at: number } | null>(null);

  async function unlink() {
    setError('');
    try {
      await skusApi.unlink(row.sku);
      onChanged?.();
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Não foi possível desvincular');
    }
  }

  async function commit() {
    if (linked) return; // o custo vem do SKU vinculado
    const c = parse(custo);
    if (c === null && row.custoUnit === null) return; // nada digitado
    if (c === row.custoUnit) return;
    if (c === null || Number.isNaN(c) || c <= 0) return fail('Custo precisa ser maior que zero');
    if (row.avgPrice !== null && c > row.avgPrice) {
      const w = warned.current;
      // Enter dispara duas tentativas seguidas (tecla + saída do campo): a confirmação precisa ser um gesto novo
      if (!w || w.value !== c || Date.now() - w.at < 600) {
        if (!w || w.value !== c) warned.current = { value: c, at: Date.now() };
        return fail(`${money(c)} é mais que o preço médio de venda (${money(row.avgPrice)}). Se estiver certo, confirme com Enter de novo.`);
      }
    }
    warned.current = null;
    setState('saving');
    setError('');
    try {
      await skusApi.save(row.sku, c);
      setState('saved');
      onSaved(row.sku, c);
      window.setTimeout(() => setState((s) => (s === 'saved' ? 'idle' : s)), 1800);
    } catch (err) {
      fail(err instanceof ApiError ? err.message : 'Não foi possível salvar');
    }
  }

  function fail(message: string) {
    setState('error');
    setError(message);
  }

  function onKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter') {
      e.currentTarget.blur();
      void commit();
    }
    if (e.key === 'Escape') {
      setCusto(toInput(row.custoUnit));
      setState('idle');
      setError('');
      e.currentTarget.blur();
    }
  }

  const missing = row.custoUnit === null;
  return (
    <li
      className="sku-row"
      data-missing={missing || undefined}
      data-state={state}
      onBlur={(e) => {
        // salva quando o foco sai da linha
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) void commit();
      }}
    >
      <ProductThumb src={row.pictureUrl} alt={row.title ?? row.sku} />
      <div className="sku-main">
        <strong title={row.title ?? row.sku}>{row.title ?? row.sku}</strong>
        <span className="sku-meta">
          <code>{row.sku}</code>
          {row.listingStatus === 'paused' && <span className="tag tag-paused">Pausado</span>}
          {row.listingStatus === 'active' && <span className="tag tag-active">Ativo</span>}
          {missing ? <span className="tag tag-missing">Sem custo</span> : <span className="tag tag-done">✓ Completo</span>}
          {platforms && row.platforms.map((p) => <span key={p} className="tag tag-platform" data-p={p}>{PLATFORM_LABELS[p]}</span>)}
          {platforms && linked && (
            <>
              <span className="tag tag-link" title="O custo deste SKU vem do SKU vinculado">Custo de {row.linkedSku}</span>
              <button type="button" className="sku-link-btn" onClick={() => void unlink()}>Desvincular</button>
            </>
          )}
          {platforms && !linked && onLink && (
            <button type="button" className="sku-link-btn" onClick={() => onLink(row)}>Vincular a outro SKU</button>
          )}
        </span>
      </div>
      <div className="sku-stats">
        <span><small>Vendidos 30d</small><b>{int(row.units30d)}</b></span>
        <span><small>Preço médio</small><b>{row.avgPrice === null ? '—' : money(row.avgPrice)}</b></span>
        <span><small>Estoque</small><b>{row.stock === null ? '—' : int(row.stock)}</b></span>
      </div>
      <label className="sku-input sku-cost">
        <small>Custo unitário</small>
        <span className="sku-field" data-locked={linked || undefined}>
          <i>R$</i>
          <input
            inputMode="decimal"
            placeholder="0,00"
            value={custo}
            onChange={(e) => {
              setCusto(e.target.value);
              if (state === 'error') setState('idle');
            }}
            onKeyDown={onKey}
            aria-invalid={state === 'error' || undefined}
            aria-label={`Custo unitário de ${row.sku}`}
            readOnly={linked}
            title={linked ? `Custo de ${row.linkedSku}. Altere lá ou desvincule.` : undefined}
          />
        </span>
      </label>
      <span className="sku-status" aria-live="polite">
        {state === 'saving' && <span className="spinner spinner-dark" aria-label="Salvando" />}
        {state === 'saved' && <span className="saved" aria-label="Salvo">✓</span>}
      </span>
      {state === 'error' && <p className="sku-error" role="alert">{error}</p>}
    </li>
  );
}
