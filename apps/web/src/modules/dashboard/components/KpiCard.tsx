import type { ReactNode } from 'react';
import { change, pct } from '../../../shared/format';
import { Icon } from '../../../shared/ui/Icon';
import { useCountUp } from '../useCountUp';

interface Props {
  label: string;
  value: number;
  previous: number;
  format: (n: number) => string;
  info: string;
  /** Margem compara em pontos percentuais em vez de variação relativa. */
  deltaMode?: 'relative' | 'points';
  tone?: 'blue' | 'navy' | 'amber' | 'teal';
  hero?: boolean;
  children?: ReactNode;
}

export function KpiCard({ label, value, previous, format, info, deltaMode = 'relative', tone = 'blue', hero, children }: Props) {
  const animated = useCountUp(value);
  const delta = deltaMode === 'points' ? value - previous : change(value, previous);
  const up = delta !== null && delta > 0.0005;
  const down = delta !== null && delta < -0.0005;
  const deltaText =
    delta === null
      ? 'sem base de comparação'
      : deltaMode === 'points'
        ? `${delta >= 0 ? '+' : ''}${(delta * 100).toLocaleString('pt-BR', { maximumFractionDigits: 1 })} p.p.`
        : `${delta >= 0 ? '+' : ''}${pct(delta)}`;

  return (
    <article className={`kpi kpi-${tone}`} data-hero={hero || undefined}>
      <header>
        <h3>{label}</h3>
        <span className="kpi-info" tabIndex={0} aria-label={`Como é calculado: ${info}`}>
          <Icon name="info" size={16} />
          <span role="tooltip">{info}</span>
        </span>
      </header>
      <p className="kpi-value money">{format(animated)}</p>
      <p className="kpi-delta" data-trend={up ? 'up' : down ? 'down' : 'flat'}>
        <span aria-hidden="true">{up ? '▲' : down ? '▼' : '•'}</span> {deltaText}
        <small> vs período anterior</small>
      </p>
      {children}
    </article>
  );
}
