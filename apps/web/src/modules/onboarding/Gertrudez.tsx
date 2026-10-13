import type { ReactNode } from 'react';
import { useTypewriter } from './useTypewriter';

interface Props {
  /** Fala da Gertrudez. Cada parágrafo é separado por \n. */
  message: string;
  mood?: 'talk' | 'party';
  /** Conteúdo exibido depois que ela termina de falar (ações do passo). */
  children?: ReactNode;
}

export function Gertrudez({ message, mood = 'talk', children }: Props) {
  const { shown, done, skip } = useTypewriter(message);

  return (
    <div className={`gz gz-${mood}`} data-speaking={!done || undefined}>
      {/* palco 3D: recortada, em primeiro plano, "saindo" pela borda inferior da tela */}
      <div className="gz-stage">
        <span className="gz-halo" aria-hidden="true" />
        <figure className="gz-figure">
          <img src="/gertrudez-cutout.webp" alt="Gertrudez, assistente da NVS Tech" width="1250" height="1330" />
        </figure>
        {mood === 'party' && <span className="gz-hand" aria-hidden="true">🎉</span>}
      </div>

      <div className="gz-body">
        <div
          className="gz-bubble"
          data-glow
          onClick={skip}
          title={done ? undefined : 'Clique para pular'}
        >
          <span className="gz-name">Gertrudez · assistente NVS</span>
          {/* leitores de tela recebem a fala completa de uma vez */}
          <p className="sr-only" aria-live="polite">{message}</p>
          <div className="gz-text" aria-hidden="true">
            {shown.split('\n').map((line, i) => (
              <p key={i}>{line}</p>
            ))}
            {!done && <span className="gz-caret" />}
          </div>
        </div>
        {/* ações só existem para o usuário depois que ela termina de falar */}
        <div className="gz-actions" data-ready={done || undefined} inert={!done}>
          {children}
        </div>
      </div>
    </div>
  );
}
