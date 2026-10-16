import './support.css';

/** Suporte (por enquanto o WhatsApp pessoal do Matheus, poucas pessoas usando). */
const SUPPORT_WHATSAPP = '5519997292504';
const SUPPORT_MESSAGE = 'Olá! Encontrei um erro no NVS Tech:';

/** Fone de ouvido fixo no topo de todas as telas: abre o WhatsApp do suporte para relatar um erro. */
export function SupportButton() {
  const href = `https://wa.me/${SUPPORT_WHATSAPP}?text=${encodeURIComponent(SUPPORT_MESSAGE)}`;
  return (
    <a
      className="support-fab"
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title="Encontrou algum erro? Fale com o suporte — (19) 99729-2504"
      aria-label="Relatar erro ao suporte pelo WhatsApp"
    >
      <svg viewBox="0 0 24 24" width={20} height={20} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M3 14v-2a9 9 0 0 1 18 0v2M21 14v3a2 2 0 0 1-2 2h-1v-7h3zM3 14v3a2 2 0 0 0 2 2h1v-7H3zM18 19a3 3 0 0 1-3 3h-2" />
      </svg>
      <span>Suporte</span>
    </a>
  );
}
