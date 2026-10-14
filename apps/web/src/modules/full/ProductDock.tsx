import { useRef, useState } from 'react';
import { WMS_ITEM_STATUS_LABELS, type WmsItemDto } from '@nvs/shared';

const BASE = 56;
const MAX_SCALE = 1.7;
const REACH = 140; // px: até onde o mouse ainda aumenta os vizinhos

/** Fotos dos itens da lista numa barra no rodapé, que aumentam ao passar o mouse (como a Dock do Mac); clique seleciona. */
export function ProductDock({ items, currentId, onPick }: { items: WmsItemDto[]; currentId: string | null; onPick: (sku: string) => void }) {
  const [mouseX, setMouseX] = useState<number | null>(null);
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  if (items.length < 2) return null;

  const scaleOf = (i: number) => {
    const el = refs.current[i];
    if (mouseX === null || !el) return 1;
    const r = el.getBoundingClientRect();
    const d = Math.abs(mouseX - (r.left + r.width / 2));
    return 1 + (MAX_SCALE - 1) * Math.max(0, 1 - d / REACH) ** 2;
  };

  return (
    <nav className="dock" aria-label="Produtos da lista" onMouseMove={(e) => setMouseX(e.clientX)} onMouseLeave={() => setMouseX(null)}>
      <div className="dock-shelf">
        {items.map((it, i) => {
          const s = scaleOf(i);
          return (
            <button
              key={it.id}
              ref={(el) => {
                refs.current[i] = el;
              }}
              type="button"
              className="dock-item"
              data-item={it.status}
              aria-current={it.id === currentId || undefined}
              style={{ width: BASE * s, height: BASE * s }}
              onClick={(e) => {
                e.stopPropagation();
                onPick(it.sku);
              }}
              title={`${it.sku} · ${it.qtyPicked}/${it.qtyRequired} · ${WMS_ITEM_STATUS_LABELS[it.status]}`}
            >
              {it.pictureUrl ? <img src={it.pictureUrl} alt="" loading="lazy" /> : <span className="dock-ph">{it.sku.slice(0, 3)}</span>}
              <span className="dock-qty">{it.qtyPicked}/{it.qtyRequired}</span>
              <span className="dock-tip">{it.sku}</span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}
