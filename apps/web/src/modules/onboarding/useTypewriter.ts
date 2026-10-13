import { useEffect, useState } from 'react';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Revela o texto letra a letra. `skip()` mostra tudo de uma vez. */
export function useTypewriter(text: string, speed = 22) {
  const [count, setCount] = useState(() => (reducedMotion() ? text.length : 0));

  useEffect(() => {
    if (reducedMotion()) {
      setCount(text.length);
      return;
    }
    setCount(0);
    const id = window.setInterval(() => {
      setCount((c) => {
        if (c >= text.length) {
          window.clearInterval(id);
          return c;
        }
        return c + 1;
      });
    }, speed);
    return () => window.clearInterval(id);
  }, [text, speed]);

  return { shown: text.slice(0, count), done: count >= text.length, skip: () => setCount(text.length) };
}
