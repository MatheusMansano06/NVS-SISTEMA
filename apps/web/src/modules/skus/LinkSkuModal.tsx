import { useEffect, useState } from 'react';
import type { SkuRowDto } from '@nvs/shared';
import { money } from '../../shared/format';
import { ApiError } from '../../shared/http';
import { ProductThumb } from '../dashboard/components/ProductThumb';
import { PLATFORM_LABELS } from './platforms';
import { skusApi } from './skus-api';

/**
 * Vincular um SKU ao SKU do mesmo produto em outra plataforma (o SKU muda, o produto é o mesmo):
 * o vinculado passa a usar o custo do escolhido.
 */
export function LinkSkuModal({ row, onDone }: { row: SkuRowDto; onDone: () => void }) {
  const [q, setQ] = useState('');
  const [items, setItems] = useState<SkuRowDto[] | null>(null);
  const [saving, setSaving] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    const c = new AbortController();
    const t = window.setTimeout(() => {
      skusApi
        .list({ q: q.trim() || undefined, filter: 'all', offset: 0, limit: 20 }, c.signal)
        // o próprio SKU e os que já são vínculo não podem ser destino
        .then((r) => setItems(r.items.filter((i) => i.sku !== row.sku && !i.linkedSku)))
        .catch((err) => (err as Error).name !== 'AbortError' && setError('Não foi possível buscar os SKUs.'));
    }, 250);
    return () => {
      window.clearTimeout(t);
      c.abort();
    };
  }, [q, row.sku]);

  async function pick(target: SkuRowDto) {
    setSaving(target.sku);
    setError('');
    try {
      await skusApi.link(row.sku, target.sku);
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Não foi possível vincular.');
      setSaving('');
    }
  }

  return (
    <div className="link-sku">
      <h2>Vincular a outro SKU</h2>
      <p>
        <code>{row.sku}</code> {row.title ? `(${row.title}) ` : ''}vai usar o custo do SKU que você escolher. Use quando é o mesmo
        produto com SKU diferente em outra plataforma.
      </p>
      <label className="search">
        <span className="sr-only">Buscar</span>
        <input autoFocus placeholder="Buscar por SKU ou título" value={q} onChange={(e) => setQ(e.target.value)} />
      </label>
      {error && <p className="banner banner-error" role="alert">{error}</p>}
      <ul className="link-list" aria-busy={items === null}>
        {items?.length === 0 && <li className="link-empty">Nenhum SKU encontrado.</li>}
        {items?.map((i) => (
          <li key={i.sku}>
            <button type="button" disabled={Boolean(saving)} onClick={() => void pick(i)}>
              <ProductThumb src={i.pictureUrl} alt={i.title ?? i.sku} />
              <span className="sku-main">
                <strong>{i.title ?? i.sku}</strong>
                <span className="sku-meta">
                  <code>{i.sku}</code>
                  {i.platforms.map((p) => <span key={p} className="tag tag-platform" data-p={p}>{PLATFORM_LABELS[p]}</span>)}
                </span>
              </span>
              <b>{saving === i.sku ? 'Vinculando…' : i.custoUnit === null ? 'Sem custo' : money(i.custoUnit)}</b>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
