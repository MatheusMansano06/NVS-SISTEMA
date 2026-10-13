import { useEffect, useRef } from 'react';

/**
 * Publica a posição do cursor como variáveis CSS (--mx/--my no container, --px/--py nos elementos [data-glow]).
 * Apenas escreve custom properties dentro de requestAnimationFrame: sem re-render do React.
 */
export function usePointerGlow<T extends HTMLElement>() {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let frame = 0;

    const onMove = (e: PointerEvent) => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const mx = (e.clientX / window.innerWidth) * 2 - 1;
        const my = (e.clientY / window.innerHeight) * 2 - 1;
        el.style.setProperty('--mx', mx.toFixed(3));
        el.style.setProperty('--my', my.toFixed(3));
        el.querySelectorAll<HTMLElement>('[data-glow]').forEach((glow) => {
          const r = glow.getBoundingClientRect();
          glow.style.setProperty('--px', `${e.clientX - r.left}px`);
          glow.style.setProperty('--py', `${e.clientY - r.top}px`);
        });
      });
    };

    window.addEventListener('pointermove', onMove, { passive: true });
    return () => {
      window.removeEventListener('pointermove', onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
