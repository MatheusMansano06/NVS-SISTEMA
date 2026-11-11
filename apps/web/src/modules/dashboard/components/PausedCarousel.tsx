import { useRef } from 'react';
import type { DashboardDto } from '@nvs/shared';
import { money } from '../../../shared/format';
import { Icon } from '../../../shared/ui/Icon';
import { ProductThumb } from './ProductThumb';

/** Carrossel dos anúncios pausados (Mercado Livre ou produtos desativados no TikTok Shop) — sem estoque primeiro. */
export function PausedCarousel({ paused, tiktok = false }: { paused: DashboardDto['paused']; tiktok?: boolean }) {
  const track = useRef<HTMLUListElement>(null);
  const scroll = (dir: 1 | -1) => {
    const el = track.current;
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  return (
    <section className="panel paused" aria-labelledby="paused-title">
      <header className="panel-head">
        <div className="paused-title">
          <h2 id="paused-title">Anúncios pausados</h2>
          {paused.total > 0 && (
            <span className="chips">
              <span className="chip">{paused.total} pausados</span>
              {paused.outOfStock > 0 && <span className="chip chip-alert">{paused.outOfStock} sem estoque</span>}
            </span>
          )}
        </div>
        {paused.items.length > 2 && (
          <div className="carousel-nav">
            <button type="button" className="icon-btn" onClick={() => scroll(-1)} aria-label="Anterior">
              <span style={{ transform: 'rotate(90deg)', display: 'grid' }}><Icon name="chevron" /></span>
            </button>
            <button type="button" className="icon-btn" onClick={() => scroll(1)} aria-label="Próximo">
              <span style={{ transform: 'rotate(-90deg)', display: 'grid' }}><Icon name="chevron" /></span>
            </button>
          </div>
        )}
      </header>

      {paused.items.length === 0 ? (
        <p className="empty">Nenhum anúncio pausado. Tudo vendendo! 🎉</p>
      ) : (
        <ul className="carousel" ref={track} aria-label="Anúncios pausados">
          {paused.items.map((l, i) => (
            <li key={l.id} className="pcard" data-oos={l.outOfStock || undefined} style={{ ['--d' as string]: `${Math.min(i, 8) * 50}ms` }}>
              <div className="pcard-photo">
                <ProductThumb src={l.pictureUrl} alt={l.title} />
                <span className="pcard-badge">{l.outOfStock ? 'Sem estoque' : tiktok ? 'Desativado' : 'Pausado'}</span>
              </div>
              <strong title={l.title}>{l.title}</strong>
              <span className="pcard-meta">
                {l.price !== null && <b className="money">{money(l.price)}</b>}
                <small>{l.accountNickname}</small>
              </span>
              {l.permalink && (
                <a href={l.permalink} target="_blank" rel="noreferrer noopener" className="link">
                  Ver no Mercado Livre ↗
                </a>
              )}
            </li>
          ))}
        </ul>
      )}
      {paused.total > paused.items.length && (
        <p className="panel-foot">Mostrando {paused.items.length} de {paused.total}. Os sem estoque aparecem primeiro.</p>
      )}
    </section>
  );
}
