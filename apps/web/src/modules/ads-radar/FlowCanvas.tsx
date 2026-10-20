import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { AdStatus } from '@nvs/shared';

export interface FlowNode {
  id: string;
  x: number;
  y: number;
  /** Nome lido pelo leitor de tela. */
  label: string;
  tone?: AdStatus | null;
  badge?: { text: string; tone: 'estourado' | 'atencao' | 'info' } | null;
  ghost?: boolean;
  locked?: boolean;
  stack?: boolean;
  onOpen?: () => void;
  children: ReactNode;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  /** Caminho de alerta (vermelho). */
  hot?: boolean;
}

interface View {
  x: number;
  y: number;
  k: number;
}

const NODE_W = 250;
const MIN_K = 0.35;
const MAX_K = 1.8;
const clampK = (k: number) => Math.min(MAX_K, Math.max(MIN_K, k));

/**
 * Canvas do fluxo (estilo n8n): grade de pontos que reage ao mouse, blocos arrastáveis ligados por fios animados,
 * arrastar o fundo para mover, roda do mouse para zoom. `flowKey` muda quando o fluxo é outro (recentraliza).
 */
export function FlowCanvas({ nodes, edges, flowKey, children }: { nodes: FlowNode[]; edges: FlowEdge[]; flowKey: string; children?: ReactNode }) {
  const stageRef = useRef<HTMLDivElement>(null);
  const gridRef = useRef<HTMLCanvasElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const [pos, setPos] = useState<Record<string, { x: number; y: number }>>({});
  const [size, setSize] = useState<Record<string, { w: number; h: number }>>({});
  const [view, setView] = useState<View>({ x: 40, y: 40, k: 1 });
  const viewRef = useRef(view);
  viewRef.current = view;
  const [swap, setSwap] = useState(false);
  const [panning, setPanning] = useState(false);

  // posição inicial de cada bloco (arrastar só mexe na tela, não é salvo)
  useEffect(() => {
    setPos(Object.fromEntries(nodes.map((n) => [n.id, { x: n.x, y: n.y }])));
    setSwap(true);
    const t = setTimeout(() => setSwap(false), 220);
    return () => clearTimeout(t);
  }, [flowKey]);
  // blocos novos no mesmo fluxo (ex.: regra criada) entram na posição sugerida
  useEffect(() => {
    setPos((p) => {
      const missing = nodes.filter((n) => !p[n.id]);
      return missing.length ? { ...p, ...Object.fromEntries(missing.map((n) => [n.id, { x: n.x, y: n.y }])) } : p;
    });
  }, [nodes]);

  // tamanho real de cada bloco (os fios saem do meio da borda)
  useLayoutEffect(() => {
    const next: Record<string, { w: number; h: number }> = {};
    let changed = false;
    for (const n of nodes) {
      const el = nodeRefs.current.get(n.id);
      if (!el) continue;
      next[n.id] = { w: el.offsetWidth, h: el.offsetHeight };
      if (size[n.id]?.w !== next[n.id]!.w || size[n.id]?.h !== next[n.id]!.h) changed = true;
    }
    if (changed || Object.keys(size).length !== Object.keys(next).length) setSize(next);
  });

  const at = (id: string) => pos[id] ?? nodes.find((n) => n.id === id) ?? { x: 0, y: 0 };

  const fit = useCallback(() => {
    const stage = stageRef.current;
    if (!stage || !nodes.length) return;
    const xs = nodes.map((n) => n.x), ys = nodes.map((n) => n.y);
    const hs = nodes.map((n) => n.y + (size[n.id]?.h ?? 140));
    const minX = Math.min(...xs), minY = Math.min(...ys);
    const w = Math.max(...xs) + NODE_W - minX, h = Math.max(...hs) - minY;
    const k = clampK(Math.min(1, (stage.clientWidth - 80) / w, (stage.clientHeight - 110) / h));
    setView({ k, x: (stage.clientWidth - w * k) / 2 - minX * k, y: (stage.clientHeight - h * k) / 2 - minY * k + 10 });
  }, [nodes, size]);

  // centraliza quando o fluxo troca (depois de medir os blocos) e quando a janela muda
  const fitted = useRef('');
  useEffect(() => {
    if (fitted.current !== flowKey && Object.keys(size).length >= nodes.length && nodes.length) {
      fitted.current = flowKey;
      fit();
    }
  }, [flowKey, size, nodes.length, fit]);
  useEffect(() => {
    const onResize = () => fit();
    addEventListener('resize', onResize);
    return () => removeEventListener('resize', onResize);
  }, [fit]);

  // ---- grade de pontos (canvas): acende e se afasta perto do mouse
  useEffect(() => {
    const stage = stageRef.current, cv = gridRef.current;
    if (!stage || !cv) return;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let mouse = { x: -999, y: -999 };
    const glow = { x: -999, y: -999 };
    let colors = { dot: '106,114,133', hot: '31,95,255' };
    const readColors = () => {
      const css = getComputedStyle(stage);
      const rgb = (v: string, fb: string) => {
        const m = /^#([0-9a-f]{6})$/i.exec(css.getPropertyValue(v).trim());
        return m ? [0, 2, 4].map((i) => parseInt(m[1]!.slice(i, i + 2), 16)).join(',') : fb;
      };
      colors = { dot: rgb('--gray-500', colors.dot), hot: rgb('--blue', colors.hot) };
    };
    const resize = () => {
      const dpr = devicePixelRatio || 1;
      cv.width = stage.clientWidth * dpr;
      cv.height = stage.clientHeight * dpr;
      cv.style.width = `${stage.clientWidth}px`;
      cv.style.height = `${stage.clientHeight}px`;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      readColors();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(stage);
    const theme = new MutationObserver(readColors);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    const move = (e: PointerEvent) => {
      const r = stage.getBoundingClientRect();
      mouse = { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const leave = () => (mouse = { x: -999, y: -999 });
    stage.addEventListener('pointermove', move);
    stage.addEventListener('pointerleave', leave);
    const t0 = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      const v = viewRef.current;
      const w = stage.clientWidth, h = stage.clientHeight, gap = 26 * v.k, t = still ? 0 : (now - t0) / 1000;
      glow.x += (mouse.x - glow.x) * 0.12;
      glow.y += (mouse.y - glow.y) * 0.12;
      ctx.clearRect(0, 0, w, h);
      const ox = ((v.x % gap) + gap) % gap, oy = ((v.y % gap) + gap) % gap;
      for (let x = ox; x < w; x += gap) {
        for (let y = oy; y < h; y += gap) {
          const dx = x - glow.x, dy = y - glow.y, d = Math.sqrt(dx * dx + dy * dy), f = Math.max(0, 1 - d / 150);
          const push = f * f * 4, nx = d ? dx / d : 0, ny = d ? dy / d : 0;
          const wave = Math.sin(t * 0.9 + (x + y) * 0.012) * 0.5 + 0.5;
          ctx.fillStyle = f > 0.02 ? `rgba(${colors.hot},${0.14 + f * 0.3})` : `rgba(${colors.dot},${0.13 + wave * 0.05})`;
          ctx.beginPath();
          ctx.arc(x + nx * push, y + ny * push, 1 + f * 0.8, 0, 6.283);
          ctx.fill();
        }
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      theme.disconnect();
      stage.removeEventListener('pointermove', move);
      stage.removeEventListener('pointerleave', leave);
    };
  }, []);

  // ---- mover o fundo e zoom
  const pan = useRef<{ x: number; y: number; vx: number; vy: number } | null>(null);
  const onStageDown = (e: React.PointerEvent) => {
    if (e.target !== e.currentTarget && !(e.target as HTMLElement).classList.contains('ar-grid')) return;
    pan.current = { x: e.clientX, y: e.clientY, vx: view.x, vy: view.y };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    setPanning(true);
  };
  const onStageMove = (e: React.PointerEvent) => {
    const p = pan.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.vx + e.clientX - p.x, y: p.vy + e.clientY - p.y }));
  };
  const onStageUp = () => {
    pan.current = null;
    setPanning(false);
  };
  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const wheel = (e: WheelEvent) => {
      if ((e.target as HTMLElement).closest('.ar-drawer')) return;
      e.preventDefault();
      const r = stage.getBoundingClientRect(), mx = e.clientX - r.left, my = e.clientY - r.top;
      setView((v) => {
        const k = clampK(v.k * (e.deltaY < 0 ? 1.1 : 0.9));
        return { k, x: mx - (mx - v.x) * (k / v.k), y: my - (my - v.y) * (k / v.k) };
      });
    };
    stage.addEventListener('wheel', wheel, { passive: false });
    return () => stage.removeEventListener('wheel', wheel);
  }, []);
  const zoomBy = (f: number) => setView((v) => ({ ...v, k: clampK(v.k * f) }));

  // ---- arrastar blocos
  const drag = useRef<{ id: string; x: number; y: number; nx: number; ny: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState<string | null>(null);
  const nodeDown = (e: React.PointerEvent, id: string) => {
    if ((e.target as HTMLElement).closest('button, input, select')) return;
    e.stopPropagation();
    const p = at(id);
    drag.current = { id, x: e.clientX, y: e.clientY, nx: p.x, ny: p.y, moved: false };
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
  };
  const nodeMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = (e.clientX - d.x) / view.k, dy = (e.clientY - d.y) / view.k;
    if (!d.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
    d.moved = true;
    setDragging(d.id);
    setPos((p) => ({ ...p, [d.id]: { x: d.nx + dx, y: d.ny + dy } }));
  };
  const nodeUp = (n: FlowNode) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    if (d && !d.moved) n.onOpen?.();
  };

  const port = (id: string, side: 'in' | 'out') => {
    const p = at(id), s = size[id] ?? { w: NODE_W, h: 120 };
    return { x: p.x + (side === 'out' ? s.w : 0), y: p.y + s.h / 2 };
  };

  return (
    <div
      ref={stageRef}
      className="ar-stage"
      data-panning={panning || undefined}
      onPointerDown={onStageDown}
      onPointerMove={onStageMove}
      onPointerUp={onStageUp}
      onPointerCancel={onStageUp}
    >
      <canvas ref={gridRef} className="ar-grid" aria-hidden="true" />
      <div className="ar-world" data-swap={swap || undefined} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.k})` }}>
        <svg className="ar-wires" aria-hidden="true">
          {edges.map((e) => {
            if (!nodes.some((n) => n.id === e.from) || !nodes.some((n) => n.id === e.to)) return null;
            const A = port(e.from, 'out'), B = port(e.to, 'in');
            const dx = Math.max(60, (B.x - A.x) / 2);
            const d = `M${A.x},${A.y} C${A.x + dx},${A.y} ${B.x - dx},${B.y} ${B.x},${B.y}`;
            const w = e.label ? e.label.length * 7 + 18 : 0;
            return (
              <g key={`${e.from}-${e.to}`}>
                <path className={`ar-wire${e.hot ? ' hot' : ''}`} d={d} />
                <path className={`ar-wire flow${e.hot ? ' hot' : ''}`} d={d} />
                {e.label && (
                  <g className={`ar-wire-tag${e.hot ? ' hot' : ''}`} transform={`translate(${(A.x + B.x) / 2},${(A.y + B.y) / 2})`}>
                    <rect x={-w / 2} y={-11} width={w} height={22} rx={11} />
                    <text textAnchor="middle" y={4}>{e.label}</text>
                  </g>
                )}
              </g>
            );
          })}
        </svg>
        {nodes.map((n) => {
          const p = at(n.id);
          return (
            <div
              key={n.id}
              ref={(el) => {
                if (el) nodeRefs.current.set(n.id, el);
                else nodeRefs.current.delete(n.id);
              }}
              role="button"
              tabIndex={0}
              aria-label={n.label}
              className={`ar-node${n.stack ? ' ar-stack' : ''}`}
              data-tone={n.tone ?? undefined}
              data-ghost={n.ghost || undefined}
              data-locked={n.locked || undefined}
              data-dragging={dragging === n.id || undefined}
              style={{ left: p.x, top: p.y }}
              onPointerDown={(e) => nodeDown(e, n.id)}
              onPointerMove={nodeMove}
              onPointerUp={() => nodeUp(n)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  n.onOpen?.();
                }
              }}
            >
              {!n.ghost && <span className="ar-port in" />}
              {!n.ghost && <span className="ar-port out" />}
              {n.badge && <span className="ar-badge" data-tone={n.badge.tone}>{n.badge.text}</span>}
              {n.children}
            </div>
          );
        })}
      </div>
      {children}
      <div className="ar-zoom">
        <button type="button" className="ar-btn" onClick={() => zoomBy(0.87)} aria-label="Diminuir zoom">−</button>
        <button type="button" className="ar-btn" onClick={fit}>Centralizar</button>
        <button type="button" className="ar-btn" onClick={() => zoomBy(1.15)} aria-label="Aumentar zoom">+</button>
      </div>
    </div>
  );
}
