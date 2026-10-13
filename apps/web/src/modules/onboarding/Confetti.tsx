const COLORS = ['#1f5fff', '#f5b800', '#0b1c4d', '#cfd4e0', '#5b8cff'];

/** Confete em CSS puro: 28 peças com posição/atraso determinísticos (sem JS de animação). */
export function Confetti() {
  return (
    <div className="confetti" aria-hidden="true">
      {Array.from({ length: 28 }, (_, i) => (
        <i
          key={i}
          style={{
            left: `${(i * 37) % 100}%`,
            background: COLORS[i % COLORS.length],
            animationDelay: `${(i % 7) * 0.12}s`,
            animationDuration: `${2.4 + (i % 5) * 0.35}s`,
            borderRadius: i % 3 === 0 ? '50%' : '3px',
          }}
        />
      ))}
    </div>
  );
}
