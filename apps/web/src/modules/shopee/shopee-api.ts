import type { ShopeeStatusDto } from '@nvs/shared';
import { http } from '../../shared/http';

const base = '/api/v1/integrations/shopee';

export const shopeeApi = {
  connectUrl: () => http<{ url: string }>(`${base}/connect`),
  status: () => http<ShopeeStatusDto>(`${base}/status`),
  sync: (connectionId?: string) => http<{ ok: true }>(`${base}/sync`, { body: { connectionId } }),
};

/** Leva o navegador para a autorização oficial da Shopee. */
export async function goToShopee(): Promise<void> {
  const { url } = await shopeeApi.connectUrl();
  window.location.assign(url);
}

const REASONS: Record<string, string> = {
  denied: 'A autorização foi cancelada na Shopee.',
  state: 'O link de autorização expirou ou foi aberto fora do sistema. Clique em conectar de novo por aqui.',
  locked: 'A Shopee ainda não está liberada para a sua empresa.',
  exchange: 'A Shopee não confirmou a autorização. Tente de novo em instantes.',
  noshop: 'A autorização não trouxe nenhuma loja. Confira se a conta tem uma loja ativa na Shopee.',
  taken: 'Essa loja da Shopee já está conectada a outra empresa no NVS Tech.',
  config: 'A integração com a Shopee está indisponível no momento.',
};

/** Lê (uma vez) o retorno da Shopee na URL (?shopee=connected | ?shopee=error&reason=...) e limpa a URL. */
export function consumeShopeeReturn(): { connected: boolean; error: string | null } | null {
  const params = new URLSearchParams(window.location.search);
  const s = params.get('shopee');
  if (!s) return null;
  window.history.replaceState(null, '', window.location.pathname);
  if (s === 'connected') return { connected: true, error: null };
  return { connected: false, error: REASONS[params.get('reason') ?? ''] ?? 'Não foi possível conectar à Shopee.' };
}
