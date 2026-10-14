import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
const KEY = 'nvs.theme';
const media = () => window.matchMedia?.('(prefers-color-scheme: dark)');

export function readTheme(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'dark' || v === 'system' ? v : 'light';
  } catch {
    return 'light';
  }
}

/** Aplica no <html> (data-theme) o tema escolhido; "Automático" segue o sistema do aparelho. */
export function applyTheme(choice: ThemeChoice = readTheme()): void {
  const dark = choice === 'dark' || (choice === 'system' && Boolean(media()?.matches));
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

/** Tema atual e troca (gravada neste navegador). */
export function useTheme(): [ThemeChoice, (c: ThemeChoice) => void] {
  const [choice, setChoice] = useState<ThemeChoice>(readTheme);
  useEffect(() => {
    applyTheme(choice);
    if (choice !== 'system') return;
    const m = media();
    const on = () => applyTheme('system');
    m?.addEventListener('change', on);
    return () => m?.removeEventListener('change', on);
  }, [choice]);
  const set = (c: ThemeChoice) => {
    try {
      localStorage.setItem(KEY, c);
    } catch {
      /* vale só para esta sessão */
    }
    setChoice(c);
  };
  return [choice, set];
}

const OPTIONS: { value: ThemeChoice; label: string }[] = [
  { value: 'light', label: 'Claro' },
  { value: 'dark', label: 'Escuro' },
  { value: 'system', label: 'Automático' },
];

/** Seletor Claro / Escuro / Automático. */
export function ThemeSwitch({ compact = false }: { compact?: boolean }) {
  const [choice, set] = useTheme();
  return (
    <div className="theme-switch" data-compact={compact || undefined} role="radiogroup" aria-label="Aparência">
      {!compact && <span>Aparência</span>}
      <div>
        {OPTIONS.map((o) => (
          <button key={o.value} type="button" role="radio" aria-checked={choice === o.value} onClick={() => set(o.value)}>
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}
