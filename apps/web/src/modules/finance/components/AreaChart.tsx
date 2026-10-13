import { useEffect, useRef, useState, type PointerEvent } from 'react';

interface Props {
  values: (number | null)[];
  labels: string[];
  format: (n: number) => string;
  tone: 'dark' | 'light';
  height?: number;
  ariaLabel: string;
}

/** Curva suave (Catmull-Rom → Bézier) com área, linha de leitura e tooltip ao passar o mouse. */
export function AreaChart({ values, labels, format, tone, height = 150, ariaLabel }: Props) {
  const wrap = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(400);
  const [hover, setHover] = useState<number | null>(null);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => e && setW(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const nums = values.map((v) => v ?? 0);
  const max = Math.max(1, ...nums);
  const min = Math.min(0, ...nums);
  const pad = 8;
  const x = (i: number) => (values.length <= 1 ? w / 2 : pad + (i / (values.length - 1)) * (w - pad * 2));
  const y = (v: number) => pad + (1 - (v - min) / (max - min)) * (height - pad * 2);
  const pts = nums.map((v, i) => [x(i), y(v)] as const);

  let d = pts.length ? `M${pts[0]![0]} ${pts[0]![1]}` : '';
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i]!;
    const p1 = pts[i]!;
    const p2 = pts[i + 1]!;
    const p3 = pts[i + 2] ?? p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]} ${c1[1]} ${c2[0]} ${c2[1]} ${p2[0]} ${p2[1]}`;
  }
  const area = pts.length ? `${d} L${x(pts.length - 1)} ${height} L${x(0)} ${height} Z` : '';
  const id = `area-${tone}`;

  function move(e: PointerEvent<SVGRectElement>) {
    const r = e.currentTarget.getBoundingClientRect();
    const rel = (e.clientX - r.left) / r.width;
    setHover(Math.max(0, Math.min(values.length - 1, Math.round(rel * (values.length - 1)))));
  }

  return (
    <div className={`area area-${tone}`} ref={wrap}>
      <svg width="100%" height={height} viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" role="img" aria-label={ariaLabel}>
        <defs>
          <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor={tone === 'dark' ? '#ffffff' : '#1f5fff'} stopOpacity={tone === 'dark' ? 0.28 : 0.2} />
            <stop offset="1" stopColor={tone === 'dark' ? '#ffffff' : '#1f5fff'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {values.length > 1 && <path d={area} fill={`url(#${id})`} />}
        {values.length > 1 && <path d={d} className="area-line" vectorEffect="non-scaling-stroke" />}
        {hover !== null && pts[hover] && (
          <g className="area-hover">
            <line x1={pts[hover][0]} x2={pts[hover][0]} y1={0} y2={height} />
            <circle cx={pts[hover][0]} cy={pts[hover][1]} r="5" />
          </g>
        )}
        <rect x="0" y="0" width={w} height={height} fill="transparent" onPointerMove={move} onPointerDown={move} onPointerLeave={() => setHover(null)} />
      </svg>
      {hover !== null && pts[hover] && (
        <div className="area-tip" style={{ left: Math.min(Math.max(pts[hover][0], 60), w - 60) }}>
          <small>{labels[hover]}</small>
          <b>{values[hover] === null ? '—' : format(values[hover]!)}</b>
        </div>
      )}
    </div>
  );
}
