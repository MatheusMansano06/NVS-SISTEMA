import type { MlStatusDto } from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/integrations/mercado-livre';

export const mlApi = {
  connectUrl: () => http<{ url: string }>(`${base}/connect`),
  status: () => http<MlStatusDto>(`${base}/status`),
  sync: (connectionId?: string) => http<{ ok: true }>(`${base}/sync`, { body: { connectionId } }),
};

/** Leva o navegador para a autorização oficial do Mercado Livre. */
export async function goToMercadoLivre(): Promise<void> {
  const { url } = await mlApi.connectUrl();
  window.location.assign(url);
}

const REASONS: Record<string, string> = {
  denied: 'A autorização foi cancelada no Mercado Livre.',
  state: 'O link de autorização expirou. Tente de novo.',
  exchange: 'O Mercado Livre não confirmou a autorização. Tente de novo em instantes.',
  taken: 'Essa conta do Mercado Livre já está conectada a outra empresa no NVS Tech.',
  config: 'A integração com o Mercado Livre está indisponível no momento.',
};

/** Lê (uma vez) o retorno do Mercado Livre na URL (?ml=connected | ?ml=error&reason=...) e limpa a URL. */
export function consumeMlReturn(): { connected: boolean; error: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const ml = params.get('ml');
  if (!ml) return null;
  window.history.replaceState(null, '', window.location.pathname);
  if (ml === 'connected') return { connected: true, error: null };
  return { connected: false, error: REASONS[params.get('reason') ?? ''] ?? 'Não foi possível conectar ao Mercado Livre.' };
}
