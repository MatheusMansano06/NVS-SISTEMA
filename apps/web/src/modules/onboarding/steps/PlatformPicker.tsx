import { AVAILABLE_MARKETPLACES, type Marketplace } from '@nvs/shared';

const OPTIONS: { id: Marketplace; name: string; tagline: string; logo: string }[] = [
  { id: 'mercado_livre', name: 'Mercado Livre', tagline: 'Pedidos, anúncios e financeiro', logo: '/marketplaces/mercado-livre.svg' },
  { id: 'shopee', name: 'Shopee', tagline: 'Em breve na NVS Tech', logo: '/marketplaces/shopee.svg' },
  { id: 'tiktok_shop', name: 'TikTok Shop', tagline: 'Em breve na NVS Tech', logo: '/marketplaces/tiktok.svg' },
];

interface Props {
  value: Marketplace | null;
  onChange: (m: Marketplace) => void;
}

export function PlatformPicker({ value, onChange }: Props) {
  return (
    <div className="platforms" role="radiogroup" aria-label="Plataforma de vendas">
      {OPTIONS.map((o) => {
        const available = AVAILABLE_MARKETPLACES.includes(o.id);
        const selected = value === o.id;
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={selected}
            disabled={!available}
            className={`platform platform-${o.id}`}
            onClick={() => onChange(o.id)}
          >
            <span className="platform-mark" aria-hidden="true">
              <img src={o.logo} alt="" />
            </span>
            <span className="platform-text">
              <strong>{o.name}</strong>
              <small>{o.tagline}</small>
            </span>
            {available ? (
              <span className="platform-check" aria-hidden="true">
                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round"><path d="M5 12.5l4.5 4.5L19 7.5" /></svg>
              </span>
            ) : (
              <span className="platform-soon">Em breve</span>
            )}
          </button>
        );
      })}
    </div>
  );
}
