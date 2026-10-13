import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Gertrudez } from '../../modules/onboarding/Gertrudez';
import { toursApi } from './tours-api';
import '../../modules/onboarding/onboarding.css';
import './tour.css';

export interface TourStep {
  /** Seletor CSS do elemento explicado; sem alvo (ou não encontrado) o balão aparece no centro. */
  target?: string;
  title: string;
  text: string;
}

interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

const PAD = 8;
/** Evento global para abrir o tour da tela atual. */
export const TOUR_EVENT = 'nvs:tour';
const BUBBLE_W = 380;

/**
 * Tour guiado da Gertrudez: na primeira visita à tela, escurece tudo, destaca um elemento por vez e explica.
 * Enquanto aberto, o resto do sistema fica inerte (só Pular / Voltar / Entendi funcionam).
 * `ready` = a tela já tem o conteúdo que os passos apontam.
 */
export function useGuidedTour(id: string, steps: TourStep[], ready: boolean) {
  const [open, setOpen] = useState(false);
  const started = useRef(false);

  useEffect(() => {
    if (!ready || started.current) return;
    started.current = true;
    toursApi.seen().then((s) => {
      if (!s.has(id)) setOpen(true);
    });
  }, [id, ready]);

  // "Rever tour desta tela" no menu do usuário
  useEffect(() => {
    const open = () => setOpen(true);
    window.addEventListener(TOUR_EVENT, open);
    return () => window.removeEventListener(TOUR_EVENT, open);
  }, []);

  const close = useCallback(
    (status: 'done' | 'skipped') => {
      setOpen(false);
      void toursApi.save(id, status);
    },
    [id],
  );

  const element = open ? <TourOverlay steps={steps} onClose={close} /> : null;
  return { start: () => setOpen(true), element };
}

function TourOverlay({ steps, onClose }: { steps: TourStep[]; onClose: (s: 'done' | 'skipped') => void }) {
  const [i, setI] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const step = steps[i]!;
  const last = i === steps.length - 1;

  // o resto do app fica inerte (sem clique, foco ou teclado) enquanto o tour está aberto
  useEffect(() => {
    const root = document.getElementById('root');
    root?.setAttribute('inert', '');
    document.body.style.overflow = 'hidden';
    return () => {
      root?.removeAttribute('inert');
      document.body.style.overflow = '';
    };
  }, []);

  const measure = useCallback(() => {
    const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    if (!el) return setRect(null);
    const r = el.getBoundingClientRect();
    // destaque recortado à área visível (alvos maiores que a tela, como uma lista longa)
    const top = Math.max(8, r.top - PAD);
    const bottom = Math.min(window.innerHeight - 8, r.bottom + PAD);
    const left = Math.max(8, r.left - PAD);
    const right = Math.min(window.innerWidth - 8, r.right + PAD);
    if (bottom - top < 24) return setRect(null);
    setRect({ top, left, width: right - left, height: bottom - top });
  }, [step.target]);

  useLayoutEffect(() => {
    const el = step.target ? document.querySelector<HTMLElement>(step.target) : null;
    if (el) {
      // rolagem instantânea (a página está travada para o usuário, não para o tour) e medida no próximo quadro
      const tall = el.getBoundingClientRect().height > window.innerHeight * 0.55;
      el.scrollIntoView({ block: tall ? 'start' : 'center', behavior: 'instant' as ScrollBehavior });
    }
    measure();
    const raf = requestAnimationFrame(measure);
    const t = window.setTimeout(measure, 60); // aba em segundo plano não desenha quadros
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(t);
    };
  }, [step.target, measure]);

  useEffect(() => {
    window.addEventListener('resize', measure);
    window.addEventListener('scroll', measure, true);
    return () => {
      window.removeEventListener('resize', measure);
      window.removeEventListener('scroll', measure, true);
    };
  }, [measure]);

  useEffect(() => nextRef.current?.focus(), [i]);

  const next = () => (last ? onClose('done') : setI(i + 1));
  const back = () => setI(Math.max(0, i - 1));

  // abertura e encerramento: a Gertrudez em tela cheia, igual à trilha de conectar o ML
  if (!step.target && (i === 0 || last)) {
    return createPortal(
      <div
        className="tour tour-full"
        role="dialog"
        aria-modal="true"
        aria-label="Gertrudez ensina"
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose('skipped');
        }}
      >
        <div className="onb tour-onb">
          <header className="onb-top tour-full-top">
            <span className="tour-full-count">{last ? 'Tudo pronto' : `${steps.length - 2} dicas rápidas`}</span>
            <button type="button" className="tour-exit tour-exit-static" onClick={() => onClose('skipped')}>Sair do tour ✕</button>
          </header>
          <main className="onb-stage" key={i}>
            <Gertrudez message={`${step.title}\n${step.text}`} mood={last && i > 0 ? 'party' : 'talk'}>
              <div className="tour-full-actions">
                <button ref={nextRef} type="button" className="btn btn-primary" onClick={next}>
                  {last ? 'Concluir' : 'Me mostra →'}
                </button>
                {!last && <button type="button" className="link" onClick={() => onClose('skipped')}>Agora não, pular</button>}
                {last && i > 0 && <button type="button" className="link" onClick={back}>Voltar uma dica</button>}
              </div>
            </Gertrudez>
          </main>
        </div>
      </div>,
      document.body,
    );
  }

  // balão abaixo do alvo quando cabe; senão acima; sem alvo, no centro
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const width = Math.min(BUBBLE_W, vw - 32);
  let style: React.CSSProperties = { width, left: (vw - width) / 2, top: Math.max(16, vh / 2 - 140) };
  let side: 'below' | 'above' | 'center' | 'float' = 'center';
  const BUBBLE_H = 280;
  if (rect) {
    const left = Math.min(Math.max(16, rect.left + rect.width / 2 - width / 2), vw - width - 16);
    const spaceBelow = vh - (rect.top + rect.height);
    if (spaceBelow >= BUBBLE_H + 14) {
      style = { width, left, top: rect.top + rect.height + 14 };
      side = 'below';
    } else if (rect.top >= BUBBLE_H + 14) {
      style = { width, left, bottom: vh - rect.top + 14 };
      side = 'above';
    } else {
      // o alvo ocupa a tela: o balão flutua no canto inferior direito, por cima
      style = { width, right: 16, bottom: 16 };
      side = 'float';
    }
  }

  return createPortal(
    <div
      className="tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby="tour-title"
      aria-describedby="tour-text"
      onKeyDown={(e) => {
        if (e.key === 'Escape') onClose('skipped');
        if (e.key === 'ArrowRight') next();
        if (e.key === 'ArrowLeft') back();
      }}
    >
      {rect ? (
        <div className="tour-spot" style={{ top: rect.top, left: rect.left, width: rect.width, height: rect.height }} aria-hidden="true" />
      ) : (
        <div className="tour-dim" aria-hidden="true" />
      )}
      <button type="button" className="tour-exit" onClick={() => onClose('skipped')}>Sair do tour ✕</button>
      <div className="tour-bubble" data-side={side} style={style}>
        <div className="tour-head">
          <img className="tour-gz" src="/gertrudez.webp" alt="" aria-hidden="true" />
          <span className="tour-name">Gertrudez ensina</span>
          <span className="tour-count">{i} de {steps.length - 2}</span>
        </div>
        <h2 id="tour-title">{step.title}</h2>
        <p id="tour-text">{step.text}</p>
        <div className="tour-dots" aria-hidden="true">
          {steps.slice(1, -1).map((_, k) => <span key={k} data-on={k + 1 === i || undefined} data-done={k + 1 < i || undefined} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="link" onClick={() => onClose('skipped')}>Pular tour</button>
          <span className="tour-spacer" />
          {i > 0 && <button type="button" className="act" onClick={back}>Voltar</button>}
          <button ref={nextRef} type="button" className="btn btn-primary tour-next" onClick={next}>
            Entendi →
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
