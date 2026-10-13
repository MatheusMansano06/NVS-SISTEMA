import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import type { SeriesPoint } from '@nvs/shared';
import { compactMoney, money } from '../../../shared/format';

type Key = 'revenue' | 'profit';
const SERIES: { key: Key; label: string; color: string }[] = [
  { key: 'revenue', label: 'Faturamento', color: '#1f5fff' },
  { key: 'profit', label: 'Lucro bruto', color: '#d99a00' },
];

const H = 280;
const PAD = { top: 16, right: 16, bottom: 30, left: 64 };

/** Escala "bonita": 0 até um teto arredondado, com 4 divisões. */
function niceTicks(max: number): number[] {
  if (max <= 0) return [0, 1, 2, 3, 4];
  const raw = max / 4;
  const pow = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? raw;
  return [0, 1, 2, 3, 4].map((i) => i * step);
}

function bucketLabel(iso: string, granularity: 'hour' | 'day', long = false): string {
  const [date, time] = iso.split('T');
  const [, m, d] = (date ?? '').split('-');
  const months = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun', 'jul', 'ago', 'set', 'out', 'nov', 'dez'];
  const dayLabel = `${d} ${months[Number(m) - 1]}`;
  if (granularity === 'hour') {
    const h = (time ?? '00').slice(0, 2);
    return long ? `${dayLabel}, ${h}h–${String(Number(h) + 1).padStart(2, '0')}h` : `${h}h`;
  }
  return dayLabel;
}

export function RevenueChart({ series, granularity }: { series: SeriesPoint[]; granularity: 'hour' | 'day' }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [hidden, setHidden] = useState<Record<Key, boolean>>({ revenue: false, profit: false });
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => entry && setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const visible = SERIES.filter((s) => !hidden[s.key]);
  const ticks = useMemo(() => {
    const max = Math.max(0, ...series.flatMap((p) => visible.map((s) => p[s.key])));
    return niceTicks(max);
  }, [series, visible]);
  const top = ticks[ticks.length - 1] || 1;
  const min = Math.min(0, ...series.flatMap((p) => visible.map((s) => p[s.key])));

  const innerW = Math.max(10, width - PAD.left - PAD.right);
  const innerH = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (series.length <= 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v: number) => PAD.top + innerH - ((v - min) / (top - min)) * innerH;

  const path = (key: Key) => series.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)} ${y(p[key]).toFixed(1)}`).join('');
  const labelEvery = Math.max(1, Math.ceil(series.length / Math.max(2, Math.floor(innerW / 64))));

  function onMove(e: PointerEvent<SVGRectElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - rect.left) / rect.width;
    setHover(Math.max(0, Math.min(series.length - 1, Math.round(rel * (series.length - 1)))));
  }

  const point = hover !== null ? series[hover] : null;
  const tipLeft = hover !== null ? Math.min(Math.max(x(hover), 90), width - 90) : 0;

  return (
    <section className="panel chart-panel" aria-labelledby="chart-title">
      <header className="panel-head">
        <h2 id="chart-title">Resumo de receitas</h2>
        <div className="legend" role="group" aria-label="Séries do gráfico">
          {SERIES.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={!hidden[s.key]}
              onClick={() => setHidden((h) => ({ ...h, [s.key]: !h[s.key] }))}
              style={{ ['--c' as string]: s.color }}
            >
              <span className="swatch" aria-hidden="true" />
              {s.label}
            </button>
          ))}
        </div>
      </header>

      <div className="chart" ref={wrap}>
        <svg width={width} height={H} role="img" aria-label="Faturamento e lucro bruto no período">
          <defs>
            <linearGradient id="area-revenue" x1="0" x2="0" y1="0" y2="1">
              <stop offset="0" stopColor="#1f5fff" stopOpacity=".22" />
              <stop offset="1" stopColor="#1f5fff" stopOpacity="0" />
            </linearGradient>
          </defs>

          {ticks.map((t) => (
            <g key={t} className="grid">
              <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} />
              <text x={PAD.left - 10} y={y(t)} dy="4" textAnchor="end" className="money">
                {compactMoney(t)}
              </text>
            </g>
          ))}
          {series.map((p, i) =>
            i % labelEvery === 0 ? (
              <text key={p.bucket} className="axis-x" x={x(i)} y={H - 8} textAnchor="middle">
                {bucketLabel(p.bucket, granularity)}
              </text>
            ) : null,
          )}

          {!hidden.revenue && (
            <path className="area" d={`${path('revenue')}L${x(series.length - 1)} ${y(min)}L${x(0)} ${y(min)}Z`} fill="url(#area-revenue)" />
          )}
          {visible.map((s) => (
            <path key={s.key} className="line" d={path(s.key)} stroke={s.color} />
          ))}

          {point && hover !== null && (
            <g className="crosshair">
              <line x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + innerH} />
              {visible.map((s) => (
                <circle key={s.key} cx={x(hover)} cy={y(point[s.key])} r="5" fill={s.color} />
              ))}
            </g>
          )}

          <rect
            className="hit"
            x={PAD.left}
            y={PAD.top}
            width={innerW}
            height={innerH}
            onPointerMove={onMove}
            onPointerDown={onMove}
            onPointerLeave={() => setHover(null)}
          />
        </svg>

        {point && (
          <div className="tooltip" style={{ left: tipLeft }} role="status">
            <strong>{bucketLabel(point.bucket, granularity, true)}</strong>
            {visible.map((s) => (
              <span key={s.key} style={{ ['--c' as string]: s.color }}>
                <i aria-hidden="true" /> {s.label} <b className="money">{money(point[s.key])}</b>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* versão em tabela para leitores de tela */}
      <table className="sr-only">
        <caption>Faturamento e lucro bruto por {granularity === 'hour' ? 'hora' : 'dia'}</caption>
        <thead>
          <tr><th>Período</th><th>Faturamento</th><th>Lucro bruto</th></tr>
        </thead>
        <tbody>
          {series.map((p) => (
            <tr key={p.bucket}>
              <td>{bucketLabel(p.bucket, granularity, true)}</td>
              <td>{money(p.revenue)}</td>
              <td>{money(p.profit)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  );
}
