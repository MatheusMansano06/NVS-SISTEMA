import { useEffect, useRef, useState } from 'react';
import { LISTING_TYPE_LABELS, LOGISTIC_BUCKETS, LOGISTIC_LABELS, type LogisticBucketId, type MarginBand, type SaleStatus } from '@nvs/shared';
import type { LineFilters } from '../finance-api';

const STATUS: Record<SaleStatus, string> = { aprovada: 'Aprovada', cancelada: 'Cancelada', devolucao: 'Devolução parcial' };
const BANDS: Record<MarginBand, string> = { bom: 'Boa (≥ 13%)', atencao: 'Atenção (10–13%)', critico: 'Crítica (< 10%)' };
const COSTS = { com_custo: 'Com custo', sem_custo: 'Sem custo' } as const;

interface Props {
  value: LineFilters;
  onChange: (f: LineFilters) => void;
  considerarFc: boolean;
  onConsiderarFc: (v: boolean) => void;
}

/** Botão "+ Filtro" com painel de campos rotulados (padrão do NVS-WMS) e chips dos filtros ativos. */
export function FilterPanel({ value, onChange, considerarFc, onConsiderarFc }: Props) {
  const [open, setOpen] = useState(false);
  const [sku, setSku] = useState(value.sku ?? '');
  const [pedido, setPedido] = useState(value.pedido ?? '');
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setSku(value.sku ?? '');
    setPedido(value.pedido ?? '');
  }, [value.sku, value.pedido]);

  // fecha ao clicar fora ou apertar Esc
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => !box.current?.contains(e.target as Node) && setOpen(false);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const set = <K extends keyof LineFilters>(k: K, v: LineFilters[K] | '') => onChange({ ...value, [k]: v || undefined });

  const chips: { key: keyof LineFilters | 'fc'; label: string }[] = [];
  if (value.status) chips.push({ key: 'status', label: `Status: ${STATUS[value.status]}` });
  if (value.listingType) chips.push({ key: 'listingType', label: `Modalidade: ${LISTING_TYPE_LABELS[value.listingType] ?? value.listingType}` });
  if (value.bucket) chips.push({ key: 'bucket', label: `Frete: ${LOGISTIC_LABELS[value.bucket]}` });
  if (value.custo) chips.push({ key: 'custo', label: COSTS[value.custo] });
  if (value.margem) chips.push({ key: 'margem', label: `Margem: ${BANDS[value.margem]}` });
  if (value.sku) chips.push({ key: 'sku', label: `SKU: ${value.sku}` });
  if (value.pedido) chips.push({ key: 'pedido', label: `Pedido/MLB: ${value.pedido}` });
  if (considerarFc) chips.push({ key: 'fc', label: 'Considerando frete comprador' });

  return (
    <div className="fpanel" ref={box}>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        + Filtro{chips.length ? <span className="fcount">{chips.length}</span> : null}
      </button>
      {chips.length > 0 && (
        <ul className="fchips">
          {chips.map((c) => (
            <li key={c.key}>
              {c.label}
              <button
                type="button"
                aria-label={`Remover filtro ${c.label}`}
                onClick={() => (c.key === 'fc' ? onConsiderarFc(false) : set(c.key, undefined))}
              >
                ×
              </button>
            </li>
          ))}
          <li className="fchips-clear">
            <button type="button" className="link" onClick={() => { onChange({}); onConsiderarFc(false); }}>Limpar</button>
          </li>
        </ul>
      )}

      {open && (
        <div className="fpop" role="dialog" aria-label="Filtros">
          <label>
            <span>Status</span>
            <select value={value.status ?? ''} onChange={(e) => set('status', e.target.value as SaleStatus)}>
              <option value="">Todos</option>
              {(Object.keys(STATUS) as SaleStatus[]).map((k) => <option key={k} value={k}>{STATUS[k]}</option>)}
            </select>
          </label>
          <label>
            <span>Modalidade</span>
            <select value={value.listingType ?? ''} onChange={(e) => set('listingType', e.target.value)}>
              <option value="">Todas</option>
              {['gold_special', 'gold_pro'].map((k) => <option key={k} value={k}>{LISTING_TYPE_LABELS[k]}</option>)}
            </select>
          </label>
          <label>
            <span>Tipo do frete</span>
            <select value={value.bucket ?? ''} onChange={(e) => set('bucket', e.target.value as LogisticBucketId)}>
              <option value="">Todos</option>
              {LOGISTIC_BUCKETS.map((b) => <option key={b} value={b}>{LOGISTIC_LABELS[b]}</option>)}
            </select>
          </label>
          <label>
            <span>Custo</span>
            <select value={value.custo ?? ''} onChange={(e) => set('custo', e.target.value as LineFilters['custo'])}>
              <option value="">Todos</option>
              <option value="com_custo">Com custo</option>
              <option value="sem_custo">Sem custo</option>
            </select>
          </label>
          <label>
            <span>Margem (MC%)</span>
            <select value={value.margem ?? ''} onChange={(e) => set('margem', e.target.value as MarginBand)}>
              <option value="">Todas</option>
              {(Object.keys(BANDS) as MarginBand[]).map((k) => <option key={k} value={k}>{BANDS[k]}</option>)}
            </select>
          </label>
          <label>
            <span>SKU</span>
            <input
              placeholder="digite e tecle Enter"
              value={sku}
              onChange={(e) => setSku(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && set('sku', sku.trim())}
              onBlur={() => set('sku', sku.trim())}
            />
          </label>
          <label>
            <span>Nº Pedido / MLB</span>
            <input
              placeholder="digite e tecle Enter"
              value={pedido}
              onChange={(e) => setPedido(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && set('pedido', pedido.trim())}
              onBlur={() => set('pedido', pedido.trim())}
            />
          </label>
          <label className="fcheck">
            <input type="checkbox" checked={considerarFc} onChange={(e) => onConsiderarFc(e.target.checked)} />
            <span>Considerar frete comprador na margem</span>
          </label>
          <button type="button" className="btn btn-primary" onClick={() => setOpen(false)}>Fechar</button>
        </div>
      )}
    </div>
  );
}
