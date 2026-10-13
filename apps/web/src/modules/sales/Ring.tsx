import { useState } from 'react';
import { pct } from '../../shared/format';

/** Paleta categórica (mesma família do dashboard), em ordem de uso. */
export const SERIES = ['#1f5fff', '#e8590c', '#0e8a74', '#7048e8', '#d99a00', '#d6336c', '#1098ad', '#5c7cfa', '#868e96'];

export interface RingPart {
  key: string;
  label: string;
  /** Texto ao passar o mouse (ex.: nome do estado). */
  title?: string;
  value: number;
  /** Texto extra na legenda (ex.: contagem). */
  extra?: string;
}

/** Rosca com legenda (valor %) e destaque ao passar o mouse. */
export function Ring({ parts, title, center }: { parts: RingPart[]; title: string; center?: string }) {
  const [active, setActive] = useState<string | null>(null);
  const r = 46;
  const c = 2 * Math.PI * r;
  const total = parts.reduce((s, p) => s + p.value, 0);
  let acc = 0;
  const gap = parts.length > 1 ? 2 : 0;
  return (
    <div className="sring">
      <svg viewBox="0 0 120 120" width="120" height="120" role="img" aria-label={title}>
        <circle cx="60" cy="60" r={r} className="sring-track" />
        {total > 0 &&
          parts.map((p, i) => {
            const len = (p.value / total) * c;
            const el = (
              <circle
                key={p.key}
                cx="60"
                cy="60"
                r={r}
                fill="none"
                stroke={SERIES[i % SERIES.length]}
                strokeWidth={active === p.key ? 18 : 14}
                strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
                strokeDashoffset={-acc}
                transform="rotate(-90 60 60)"
                style={{ transition: 'stroke-width .2s, opacity .2s', opacity: active && active !== p.key ? 0.3 : 1 }}
                onPointerEnter={() => setActive(p.key)}
                onPointerLeave={() => setActive(null)}
              />
            );
            acc += len;
            return el;
          })}
        {center && <text x="60" y="65" textAnchor="middle" className="sring-center">{center}</text>}
      </svg>
      <ul className="sring-legend">
        {parts.map((p, i) => (
          <li key={p.key} title={p.title} data-active={active === p.key || undefined} onPointerEnter={() => setActive(p.key)} onPointerLeave={() => setActive(null)}>
            <i style={{ background: SERIES[i % SERIES.length] }} />
            <span>{p.label}</span>
            <b>{total ? pct(p.value / total, 1) : '—'}</b>
            {p.extra && <small>{p.extra}</small>}
          </li>
        ))}
        {!parts.length && <li className="sring-empty">Sem dados no período</li>}
      </ul>
    </div>
  );
}
