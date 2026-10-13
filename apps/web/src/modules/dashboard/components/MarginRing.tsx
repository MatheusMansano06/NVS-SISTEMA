/** Anel de margem (0–60% preenche o anel inteiro; acima disso fica cheio). */
export function MarginRing({ margin }: { margin: number }) {
  const r = 26;
  const c = 2 * Math.PI * r;
  const fill = Math.max(0, Math.min(1, margin / 0.6));
  return (
    <svg className="ring" viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
      <circle cx="32" cy="32" r={r} className="ring-track" />
      <circle cx="32" cy="32" r={r} className="ring-fill" strokeDasharray={c} strokeDashoffset={c * (1 - fill)} />
    </svg>
  );
}
