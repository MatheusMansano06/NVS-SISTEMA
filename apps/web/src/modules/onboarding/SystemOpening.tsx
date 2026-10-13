import { useEffect } from 'react';
import { useTypewriter } from './useTypewriter';

const DURATION_MS = 4200;

/**
 * Vinheta de abertura do sistema NVS Tech, exibida uma única vez ao concluir o passo a passo.
 * Pode ser pulada (clique, Enter ou Esc). Com "reduzir movimento" ativo, dura quase nada.
 */
export function SystemOpening({ onDone }: { onDone: () => void }) {
  const { shown, done } = useTypewriter('Prontinho! Abrindo o sistema NVS Tech para você…', 28);

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const timer = window.setTimeout(onDone, reduced ? 600 : DURATION_MS);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' || e.key === 'Enter') onDone();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener('keydown', onKey);
    };
  }, [onDone]);

  return (
    <div className="opening" role="status" aria-label="Abrindo o sistema NVS Tech">
      <div className="opening-rings" aria-hidden="true">
        <i /><i /><i />
      </div>

      <div className="opening-logo">
        <img src="/nvs-logo.webp" alt="NVS Tech" width="420" height="190" />
        <span className="opening-shine" aria-hidden="true" />
      </div>

      <div className="opening-gz">
        <img src="/gertrudez.webp" alt="" width="64" height="64" />
        <p aria-hidden="true">
          {shown}
          {!done && <span className="gz-caret" />}
        </p>
      </div>

      <div className="opening-bar" aria-hidden="true">
        <span />
      </div>

      <button type="button" className="link opening-skip" onClick={onDone}>
        Pular
      </button>
    </div>
  );
}
