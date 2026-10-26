import { useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import './hint.css';

/**
 * "?" ao lado de um termo: passar o mouse (ou focar com Tab, ou tocar) mostra a explicação.
 * O balão vai para o <body> com posição fixa para não ser cortado por cartões com overflow escondido.
 */
export function Hint({ children, label }: { children: string; label?: string }) {
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number; below: boolean } | null>(null);
  const show = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(Math.max(r.left + r.width / 2, 150), window.innerWidth - 150);
    setPos({ x, y: r.top < 140 ? r.bottom + 8 : r.top - 8, below: r.top < 140 });
  };
  const hide = () => setPos(null);
  return (
    <>
      {/* span, não button: o "?" também aparece dentro de cartões que já são botões */}
      <span
        ref={ref} role="button" tabIndex={0} className="hint" aria-label={label ? `O que é ${label}?` : 'Explicação'} aria-describedby={pos ? id : undefined}
        onMouseEnter={show} onMouseLeave={hide} onFocus={show} onBlur={hide}
        onClick={(e) => { e.stopPropagation(); if (pos) hide(); else show(); }}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); if (pos) hide(); else show(); } }}
      >
        ?
      </span>
      {pos && createPortal(
        <div id={id} role="tooltip" className="hint-tip" data-below={pos.below || undefined} style={{ left: pos.x, top: pos.y }}>{children}</div>,
        document.body,
      )}
    </>
  );
}
