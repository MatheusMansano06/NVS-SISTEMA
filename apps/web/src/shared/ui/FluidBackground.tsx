/** Fundo fluido em CSS/SVG puro: sem imagens, sem JS, animação leve só com transform. */
import './fluid.css';

export function FluidBackground({ lines = true }: { lines?: boolean }) {
  return (
    <div className="fluid-bg" aria-hidden="true">
      <span className="blob blob-blue" />
      <span className="blob blob-yellow" />
      <span className="blob blob-gray" />
      {lines && (
        <svg className="fluid-lines" viewBox="0 0 1440 900" preserveAspectRatio="xMidYMid slice">
          <defs>
            <linearGradient id="nvs-line" x1="0" x2="1">
              <stop offset="0" stopColor="#1f5fff" stopOpacity="0" />
              <stop offset=".45" stopColor="#1f5fff" stopOpacity=".55" />
              <stop offset=".8" stopColor="#f5b800" stopOpacity=".7" />
              <stop offset="1" stopColor="#f5b800" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path d="M-40 640C220 560 330 760 620 690S980 420 1240 470 1520 330 1520 330" />
          <path d="M-40 720C260 660 380 820 700 760S1040 540 1300 590 1520 470 1520 470" />
          <circle cx="620" cy="690" r="5" />
          <circle cx="1240" cy="470" r="5" />
        </svg>
      )}
    </div>
  );
}
