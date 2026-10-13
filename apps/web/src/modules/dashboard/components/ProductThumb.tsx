import { useState } from 'react';

/** Foto do anúncio com reserva elegante quando não houver imagem (ou ela falhar). */
export function ProductThumb({ src, alt, size }: { src: string | null; alt: string; size?: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) {
    return (
      <span className="thumb thumb-empty" style={size ? { width: size, height: size } : undefined} aria-hidden="true">
        <svg viewBox="0 0 24 24" width="40%" height="40%" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 8 12 3 3 8v8l9 5 9-5zM3 8l9 5 9-5M12 13v8" />
        </svg>
      </span>
    );
  }
  return (
    <img
      className="thumb"
      src={src}
      alt={alt}
      loading="lazy"
      decoding="async"
      referrerPolicy="no-referrer"
      style={size ? { width: size, height: size } : undefined}
      onError={() => setFailed(true)}
    />
  );
}
