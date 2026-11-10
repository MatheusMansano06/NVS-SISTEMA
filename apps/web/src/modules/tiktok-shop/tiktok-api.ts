import type { TiktokStatusDto } from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/integrations/tiktok-shop';

export const tiktokApi = {
  connectUrl: () => http<{ url: string }>(`${base}/connect`),
  status: () => http<TiktokStatusDto>(`${base}/status`),
  sync: (connectionId?: string) => http<{ ok: true }>(`${base}/sync`, { body: { connectionId } }),
};

/** Leva o navegador para a autorização oficial do TikTok Shop. */
export async function goToTiktokShop(): Promise<void> {
  const { url } = await tiktokApi.connectUrl();
  window.location.assign(url);
}

const REASONS: Record<string, string> = {
  denied: 'A autorização foi cancelada no TikTok Shop.',
  state: 'O link de autorização expirou ou foi aberto fora do sistema. Clique em conectar de novo por aqui.',
  locked: 'O TikTok Shop ainda não está liberado para a sua empresa.',
  exchange: 'O TikTok Shop não confirmou a autorização. Tente de novo em instantes.',
  noshop: 'A autorização não trouxe nenhuma loja. Confira se a conta tem uma loja ativa no TikTok Shop.',
  taken: 'Essa loja do TikTok Shop já está conectada a outra empresa no NVS Tech.',
  config: 'A integração com o TikTok Shop está indisponível no momento.',
};

/** Lê (uma vez) o retorno do TikTok Shop na URL (?tiktok=connected | ?tiktok=error&reason=...) e limpa a URL. */
export function consumeTiktokReturn(): { connected: boolean; error: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const t = params.get('tiktok');
  if (!t) return null;
  window.history.replaceState(null, '', window.location.pathname);
  if (t === 'connected') return { connected: true, error: null };
  return { connected: false, error: REASONS[params.get('reason') ?? ''] ?? 'Não foi possível conectar ao TikTok Shop.' };
}
