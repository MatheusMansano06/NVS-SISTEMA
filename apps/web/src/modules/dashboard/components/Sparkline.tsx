/** Mini tendência do faturamento dentro do card (sem eixos: só o formato). */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return null;
  const w = 160;
  const h = 44;
  const max = Math.max(...values, 1);
  const pts = values.map((v, i) => [(i / (values.length - 1)) * w, h - 4 - (v / max) * (h - 8)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)} ${y.toFixed(1)}`).join('');
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="spark-fill" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#1f5fff" stopOpacity=".25" />
          <stop offset="1" stopColor="#1f5fff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={`${line}L${w} ${h}L0 ${h}Z`} fill="url(#spark-fill)" />
      <path d={line} className="spark-line" />
    </svg>
  );
}
