import { useEffect } from 'react';

/** Teclado numérico de 4 dígitos (toque ou teclado físico). */
export function PinPad({ value, onChange, onComplete, disabled, error }: { value: string; onChange: (v: string) => void; onComplete: (v: string) => void; disabled?: boolean; error?: boolean }) {
  const press = (d: string) => {
    if (disabled || value.length >= 4) return;
    const next = value + d;
    onChange(next);
    if (next.length === 4) onComplete(next);
  };
  const back = () => !disabled && onChange(value.slice(0, -1));

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (/^\d$/.test(e.key)) press(e.key);
      if (e.key === 'Backspace') back();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="pin" data-error={error || undefined}>
      <div className="pin-dots" role="status" aria-label={`${value.length} de 4 números digitados`}>
        {[0, 1, 2, 3].map((i) => <span key={i} data-on={i < value.length || undefined} />)}
      </div>
      <div className="pin-keys">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => (
          <button key={d} type="button" onClick={() => press(d)} disabled={disabled}>{d}</button>
        ))}
        <span />
        <button type="button" onClick={() => press('0')} disabled={disabled}>0</button>
        <button type="button" className="pin-back" onClick={back} disabled={disabled || !value} aria-label="Apagar">⌫</button>
      </div>
    </div>
  );
}
