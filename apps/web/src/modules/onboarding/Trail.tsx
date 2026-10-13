import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ONBOARDING_STEPS, type OnboardingStep } from '@nvs/shared';

/** Fração da estrada onde fica cada fase (welcome, platform, authorize, done). */
const STOPS = [0.14, 0.4, 0.67, 0.93];
const LEVELS: { icon: string; label: string }[] = [
  { icon: '👋', label: 'Boas-vindas' },
  { icon: '🛒', label: 'Plataforma' },
  { icon: '🔑', label: 'Autorização' },
  { icon: '🏁', label: 'Sistema NVS' },
];

/**
 * Estrada pelas bordas (rodapé → lateral direita): nasce atrás da Gertrudez e
 * contorna o conteúdo sem competir com ele.
 */
const ROAD =
  'M520 960C660 890 740 862 880 862S1200 880 1330 790 1392 520 1385 380 1392 170 1345 70';

const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/**
 * Mapa de fases estilo jogo: a ficha da Gertrudez percorre a estrada até a fase atual,
 * pintando o caminho; fases concluídas ganham check e estrela, as próximas ficam trancadas.
 */
export function Trail({ step }: { step: OnboardingStep }) {
  const roadRef = useRef<SVGPathElement>(null);
  const current = ONBOARDING_STEPS.indexOf(step);
  const target = STOPS[current] ?? 0;
  const [pos, setPos] = useState(target); // fração atual da ficha (animada)
  const [points, setPoints] = useState<DOMPoint[]>([]);
  const [token, setToken] = useState<DOMPoint | null>(null);
  const fromRef = useRef(target);

  useLayoutEffect(() => {
    const road = roadRef.current;
    if (!road) return;
    const total = road.getTotalLength();
    setPoints(STOPS.map((f) => road.getPointAtLength(total * f)));
  }, []);

  // anima a ficha da posição anterior até a fase atual
  useEffect(() => {
    const from = fromRef.current;
    fromRef.current = target;
    if (reducedMotion() || from === target) {
      setPos(target);
      return;
    }
    const duration = 1500;
    const start = performance.now();
    let frame = requestAnimationFrame(function tick(now) {
      const t = Math.min(1, (now - start) / duration);
      setPos(from + (target - from) * ease(t));
      if (t < 1) frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [target]);

  useLayoutEffect(() => {
    const road = roadRef.current;
    if (road) setToken(road.getPointAtLength(road.getTotalLength() * pos));
  }, [pos]);

  const moving = Math.abs(pos - target) > 0.001;

  return (
    <svg className="trail" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMax slice" aria-hidden="true">
      <defs>
        <linearGradient id="trail-fill" x1="0" x2="1" y1="1" y2="0">
          <stop offset="0" stopColor="#1f5fff" />
          <stop offset=".65" stopColor="#5b8cff" />
          <stop offset="1" stopColor="#f5b800" />
        </linearGradient>
        <clipPath id="token-face">
          <circle r="27" />
        </clipPath>
      </defs>

      {/* estrada desfocada */}
      <g className="trail-road">
        <path ref={roadRef} d={ROAD} className="road-base" pathLength={1} />
        <path d={ROAD} className="road-fill" pathLength={1} style={{ strokeDasharray: 1, strokeDashoffset: 1 - pos }} />
        <path d={ROAD} className="road-lane" />
      </g>

      {/* fases */}
      {points.map((p, i) => {
        const reached = pos >= STOPS[i]! - 0.001;
        const state = i < current ? 'done' : i === current ? (reached ? 'current' : 'next') : 'next';
        const level = LEVELS[i]!;
        return (
          <g key={i} className="level" data-state={state} transform={`translate(${p.x} ${p.y})`}>
            <circle r="46" className="level-ring" />
            <circle r="35" className="level-disc" />
            <text className="level-icon" dy="11">{state === 'next' ? '🔒' : level.icon}</text>
            {state === 'done' && (
              <g className="level-badge" transform="translate(26 -26)">
                <circle r="15" />
                <path d="M-6 0.5l4 4 8-8.5" />
              </g>
            )}
            {state === 'current' && (
              <g className="level-burst">
                {Array.from({ length: 8 }, (_, k) => (
                  <circle key={k} r="5" style={{ ['--a' as string]: `${k * 45}deg` }} />
                ))}
              </g>
            )}
            {/* rótulo: à direita do marco no rodapé, acima dele na lateral */}
            <text
              className="level-label"
              x={p.x > 1200 ? 40 : 58}
              y={p.x > 1200 ? -60 : 0}
              dy="6"
              textAnchor={p.x > 1200 ? 'end' : 'start'}
            >
              {i < current ? '★ ' : ''}
              {level.label}
            </text>
          </g>
        );
      })}

      {/* ficha da Gertrudez */}
      {token && (
        <g className="token" data-moving={moving || undefined} transform={`translate(${token.x} ${token.y - 70})`}>
          <ellipse className="token-shadow" cx="0" cy="70" rx="22" ry="7" />
          <g className="token-body">
            <circle r="33" className="token-ring" />
            <image href="/gertrudez.webp" x="-27" y="-27" width="54" height="54" clipPath="url(#token-face)" />
            <path className="token-pin" d="M-9 30L0 46 9 30Z" />
          </g>
        </g>
      )}
    </svg>
  );
}
