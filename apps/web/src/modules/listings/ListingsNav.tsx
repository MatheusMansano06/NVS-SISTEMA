import { useState } from 'react';
import type { TenantFeature } from '@nvs/shared';
import { navigate, usePath } from '../../app/router';
import { useFeatures } from '../../shared/features';

const LINKS: { path: string; label: string; feature: TenantFeature }[] = [
  { path: '/anuncios', label: 'Meus anúncios', feature: 'anuncios' },
  { path: '/anuncios/promocoes', label: 'Central de Promoção', feature: 'promocoes' },
  { path: '/anuncios/marketing', label: 'Central de Marketing', feature: 'marketing' },
];

/** Navegação entre as telas de anúncios. */
export function ListingsNav() {
  const path = usePath();
  const features = useFeatures();
  return (
    <nav className="lnav" aria-label="Anúncios">
      {LINKS.filter((l) => features.includes(l.feature)).map((l) => (
        <a
          key={l.path}
          href={l.path}
          aria-current={path === l.path ? 'page' : undefined}
          onClick={(e) => {
            e.preventDefault();
            navigate(l.path);
          }}
        >
          {l.label}
        </a>
      ))}
    </nav>
  );
}

const readHidden = (key: string) => {
  try {
    return localStorage.getItem(key) === '1';
  } catch {
    return false; // sem storage: sempre mostra
  }
};

/** Passo a passo curto no topo das telas: o que fazer e em que ordem. Pode ser ocultado. */
export function HowTo({ steps, storageKey, onTour }: { steps: { title: string; text: string }[]; storageKey: string; onTour?: () => void }) {
  const [hidden, setHidden] = useState(() => readHidden(storageKey));
  const toggle = (next: boolean) => {
    setHidden(next);
    try {
      if (next) localStorage.setItem(storageKey, '1');
      else localStorage.removeItem(storageKey);
    } catch {
      /* ignora */
    }
  };
  if (hidden) {
    return (
      <div className="howto-links">
        <button type="button" className="link howto-show" onClick={() => toggle(false)}>Como funciona?</button>
        {onTour && <button type="button" className="link howto-show" onClick={onTour}>Rever com a Gertrudez</button>}
      </div>
    );
  }
  return (
    <section className="howto" aria-label="Como funciona">
      <ol>
        {steps.map((s, i) => (
          <li key={s.title}>
            <span className="howto-n" aria-hidden="true">{i + 1}</span>
            <div>
              <strong>{s.title}</strong>
              <p>{s.text}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="howto-hide">
        {onTour && <button type="button" className="link" onClick={onTour}>Rever com a Gertrudez</button>}
        <button type="button" className="link" onClick={() => toggle(true)}>Entendi, ocultar</button>
      </div>
    </section>
  );
}
