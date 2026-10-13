import type { MlItem, MlOrder } from '../domain/ml-order.js';
import type { MlDiscounts, MlShipment, MlShipmentCosts } from '../domain/ml-finance.js';

export interface MlTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  user_id: number;
}

export interface MlOrderPage {
  results: MlOrder[];
  paging: { total: number; offset: number; limit: number };
}

/** Porta para a API do Mercado Livre (permite um falso nos testes). */
export interface MlApi {
  authorizationUrl(state: string, codeChallenge: string | null): string;
  exchangeCode(code: string, codeVerifier: string | null): Promise<MlTokens>;
  refresh(refreshToken: string): Promise<MlTokens>;
  me(token: string): Promise<{ id: number; nickname: string }>;
  searchOrders(token: string, sellerId: string, fromIso: string, toIso: string, offset: number): Promise<MlOrderPage>;
  order(token: string, id: string): Promise<MlOrder>;
  /**
   * IDs dos anúncios do vendedor com o status pedido. Usa a busca "scan" (sem o limite de 1.000):
   * passe o `scrollId` devolvido para buscar a próxima página; acabou quando `ids` vier vazio.
   */
  listingIds(token: string, sellerId: string, status: string, scrollId: string | null): Promise<{ ids: string[]; scrollId: string | null }>;
  /** Até 20 anúncios por chamada (multiget). Ignora os que não existirem. */
  items(token: string, ids: string[]): Promise<MlItem[]>;
  /** Detalhes do envio (modalidade, custo de tabela); null se indisponível. */
  shipment(token: string, shipmentId: string): Promise<MlShipment | null>;
  /** Custos do envio (comprador/vendedor); null se indisponível. */
  shipmentCosts(token: string, shipmentId: string): Promise<MlShipmentCosts | null>;
  /** Descontos do pedido (cupons); null se indisponível. */
  discounts(token: string, orderId: string): Promise<MlDiscounts | null>;
}

export class MlApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolivre.com.br/authorization';
export const ORDERS_PAGE_SIZE = 50;
export const LISTINGS_PAGE_SIZE = 100;

interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpMlApi implements MlApi {
  constructor(private readonly cfg: Config) {}

  authorizationUrl(state: string, codeChallenge: string | null): string {
    const qs = new URLSearchParams({
      response_type: 'code',
      client_id: this.cfg.clientId,
      redirect_uri: this.cfg.redirectUri,
      state,
    });
    if (codeChallenge) {
      qs.set('code_challenge', codeChallenge);
      qs.set('code_challenge_method', 'S256');
    }
    return `${AUTH}?${qs}`;
  }

  exchangeCode(code: string, codeVerifier: string | null) {
    const body: Record<string, string> = {
      grant_type: 'authorization_code',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      code,
      redirect_uri: this.cfg.redirectUri,
    };
    if (codeVerifier) body.code_verifier = codeVerifier;
    return this.token(body);
  }

  refresh(refreshToken: string) {
    return this.token({
      grant_type: 'refresh_token',
      client_id: this.cfg.clientId,
      client_secret: this.cfg.clientSecret,
      refresh_token: refreshToken,
    });
  }

  me(token: string) {
    return this.get<{ id: number; nickname: string }>('/users/me', token);
  }

  searchOrders(token: string, sellerId: string, fromIso: string, toIso: string, offset: number) {
    const qs = new URLSearchParams({
      seller: sellerId,
      'order.date_created.from': fromIso,
      'order.date_created.to': toIso,
      sort: 'date_desc',
      offset: String(offset),
      limit: String(ORDERS_PAGE_SIZE),
    });
    return this.get<MlOrderPage>(`/orders/search?${qs}`, token);
  }

  order(token: string, id: string) {
    return this.get<MlOrder>(`/orders/${encodeURIComponent(id)}`, token);
  }

  async listingIds(token: string, sellerId: string, status: string, scrollId: string | null) {
    const qs = new URLSearchParams({ status, search_type: 'scan', limit: String(LISTINGS_PAGE_SIZE) });
    if (scrollId) qs.set('scroll_id', scrollId);
    const r = await this.get<{ results: string[]; scroll_id?: string | null }>(
      `/users/${encodeURIComponent(sellerId)}/items/search?${qs}`,
      token,
    );
    return { ids: r.results ?? [], scrollId: r.scroll_id ?? null };
  }

  async items(token: string, ids: string[]) {
    if (!ids.length) return [];
    const qs = new URLSearchParams({
      ids: ids.slice(0, 20).join(','),
      attributes:
        'id,title,status,sub_status,price,available_quantity,permalink,secure_thumbnail,thumbnail,pictures,seller_custom_field,attributes,variations',
      include_attributes: 'all',
    });
    const r = await this.get<{ code: number; body: MlItem }[]>(`/items?${qs}`, token);
    return r.filter((x) => x.code === 200 && x.body?.id).map((x) => x.body);
  }

  /** Formato clássico do envio (shipping_option + logistic_type), o mesmo usado pelo NVS-WMS. */
  shipment(token: string, shipmentId: string) {
    return this.optional(() => this.get<MlShipment>(`/shipments/${encodeURIComponent(shipmentId)}`, token));
  }

  shipmentCosts(token: string, shipmentId: string) {
    return this.optional(() => this.get<MlShipmentCosts>(`/shipments/${encodeURIComponent(shipmentId)}/costs`, token));
  }

  discounts(token: string, orderId: string) {
    return this.optional(() => this.get<MlDiscounts>(`/orders/${encodeURIComponent(orderId)}/discounts`, token));
  }

  /** 404/403 = recurso indisponível para este pedido (não é erro da sincronização). */
  private async optional<T>(fn: () => Promise<T>): Promise<T | null> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof MlApiError && (err.status === 404 || err.status === 403)) return null;
      throw err;
    }
  }

  private async token(body: Record<string, string>): Promise<MlTokens> {
    return this.request<MlTokens>('/oauth/token', {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
    }, false);
  }

  private get<T>(path: string, token: string): Promise<T> {
    return this.request<T>(path, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' } });
  }

  /** Timeout de 15s e até 3 tentativas em 429/5xx/falha de rede (backoff exponencial). */
  private async request<T>(path: string, init: RequestInit, retry = true): Promise<T> {
    const attempts = retry ? 3 : 1;
    for (let attempt = 1; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(`${API}${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
      } catch (err) {
        if (attempt < attempts) {
          await sleep(500 * 2 ** attempt);
          continue;
        }
        throw new MlApiError(`Falha de rede com o Mercado Livre: ${(err as Error).message}`, 0);
      }
      if (res.ok) return (await res.json()) as T;
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
      throw new MlApiError(body.message || body.error || `HTTP ${res.status}`, res.status, body.error);
    }
  }
}
