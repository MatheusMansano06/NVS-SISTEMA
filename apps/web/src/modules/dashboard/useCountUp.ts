import { useEffect, useRef, useState } from 'react';

/** Anima um número do valor anterior até o novo (easing suave, ~700ms). */
export function useCountUp(target: number, duration = 700): number {
  const [value, setValue] = useState(target);
  const from = useRef(target);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      setValue(target);
      from.current = target;
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - (1 - t) ** 3;
      const v = origin + (target - origin) * eased;
      setValue(v);
      from.current = v;
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target, duration]);

  return value;
}
