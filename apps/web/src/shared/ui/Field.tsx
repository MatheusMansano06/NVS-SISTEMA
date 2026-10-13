import { useId, useState, type InputHTMLAttributes, type ReactNode } from 'react';
import './field.css';

interface FieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: string;
  error?: string;
  hint?: ReactNode;
  onValueChange: (value: string) => void;
  /** Exibe o botão de mostrar/ocultar (campos de senha). */
  revealable?: boolean;
}

export function Field({ label, error, hint, onValueChange, revealable, type = 'text', ...rest }: FieldProps) {
  const id = useId();
  const [shown, setShown] = useState(false);
  const describedBy = error ? `${id}-err` : hint ? `${id}-hint` : undefined;

  return (
    <div className="field" data-invalid={error ? '' : undefined}>
      <label htmlFor={id}>{label}</label>
      <div className="field-control">
        <input
          {...rest}
          id={id}
          type={revealable && shown ? 'text' : type}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          onChange={(e) => onValueChange(e.target.value)}
        />
        {revealable && (
          <button
            type="button"
            className="reveal"
            onClick={() => setShown((s) => !s)}
            aria-label={shown ? 'Ocultar senha' : 'Mostrar senha'}
            aria-pressed={shown}
          >
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12Z" />
              <circle cx="12" cy="12" r="3" />
              {shown && <path d="M4 4l16 16" />}
            </svg>
          </button>
        )}
      </div>
      {error ? (
        <p className="field-msg field-error" id={`${id}-err`}>{error}</p>
      ) : hint ? (
        <p className="field-msg" id={`${id}-hint`}>{hint}</p>
      ) : null}
    </div>
  );
}
