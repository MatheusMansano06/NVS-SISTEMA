import { useState } from 'react';
import type { FinanceSummaryDto } from '@nvs/shared';
import { money, pct } from '../../../shared/format';

/** Paleta validada (CVD + contraste) para as fatias da composição (Ads só quando descontado da margem). */
export const COMPOSITION_COLORS: Record<string, string> = {
  custo: '#1f5fff',
  imposto: '#d99a00',
  tarifa: '#7048e8',
  frete: '#e8590c',
  ads: '#c2255c',
  mc: '#0e8a74',
};

/** Rosca da composição sobre a base da MC, com legenda (valor + %) e destaque ao passar o mouse. */
export function Donut({ parts, mcPct }: { parts: FinanceSummaryDto['composicao']; mcPct: number | null }) {
  const [active, setActive] = useState<string | null>(null);
  const r = 52;
  const c = 2 * Math.PI * r;
  const visible = parts.filter((p) => p.pct > 0);
  const total = visible.reduce((s, p) => s + p.pct, 0) || 1;
  let acc = 0;
  const gap = visible.length > 1 ? 2.5 : 0;

  return (
    <div className="donut">
      <svg viewBox="0 0 140 140" width="140" height="140" role="img" aria-label="Composição sobre a base da margem">
        <circle cx="70" cy="70" r={r} className="donut-track" />
        {visible.map((p) => {
          const len = (p.pct / total) * c;
          const seg = (
            <circle
              key={p.key}
              cx="70"
              cy="70"
              r={r}
              fill="none"
              stroke={COMPOSITION_COLORS[p.key]}
              strokeWidth={active === p.key ? 20 : 16}
              strokeDasharray={`${Math.max(0, len - gap)} ${c}`}
              strokeDashoffset={-acc}
              transform="rotate(-90 70 70)"
              style={{ transition: 'stroke-width .2s', opacity: active && active !== p.key ? 0.35 : 1 }}
              onPointerEnter={() => setActive(p.key)}
              onPointerLeave={() => setActive(null)}
            />
          );
          acc += len;
          return seg;
        })}
        <text x="70" y="68" textAnchor="middle" className="donut-value">{mcPct === null ? '—' : pct(mcPct / 100)}</text>
        <text x="70" y="86" textAnchor="middle" className="donut-label">MC</text>
      </svg>
      <ul className="donut-legend">
        {parts.map((p) => (
          <li
            key={p.key}
            data-active={active === p.key || undefined}
            onPointerEnter={() => setActive(p.key)}
            onPointerLeave={() => setActive(null)}
          >
            <i style={{ background: COMPOSITION_COLORS[p.key] }} aria-hidden="true" />
            <span>{p.label}</span>
            <b className="money">{money(p.valor)}</b>
            <small>{pct(p.pct / 100)}</small>
          </li>
        ))}
      </ul>
    </div>
  );
}
