import { createHmac } from 'node:crypto';
import type { ShopeeEscrowDetail } from '../domain/shopee-escrow.js';
import type { ShopeeOrder } from '../domain/shopee-order.js';

export class ShopeeApiError extends Error {
  /** `code` é o campo `error` da Shopee (ex.: error_auth, invalid_access_token); null = falha de rede/HTTP. */
  constructor(message: string, readonly status: number, readonly code: string | null) {
    super(message);
    this.name = 'ShopeeApiError';
  }
}

export interface ShopeeTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  /** Lojas cobertas pela autorização (uma, ou várias quando quem autorizou foi a conta principal). */
  shopIds: string[];
}

export interface ShopeeShopInfo {
  name: string;
  region: string;
  /** Fim da autorização da loja. */
  authExpiresAt: Date | null;
}

export interface ShopeeApi {
  authorizationUrl(state: string): string;
  /** Troca o código do retorno da autorização: vem `shop_id` (conta da loja) ou `main_account_id` (conta principal). */
  exchangeCode(code: string, owner: { shopId?: string; mainAccountId?: string }): Promise<ShopeeTokens>;
  refresh(refreshToken: string, shopId: string): Promise<ShopeeTokens>;
  shopInfo(token: string, shopId: string): Promise<ShopeeShopInfo>;
  /** Pedidos criados (`create_time`) ou alterados (`update_time`) em [from, to] — no máximo 15 dias. */
  orderList(token: string, shopId: string, from: Date, to: Date, field: 'create_time' | 'update_time', cursor?: string): Promise<{ orderSns: string[]; next: string | null }>;
  /** Detalhe de até 50 pedidos. */
  orderDetails(token: string, shopId: string, orderSns: string[]): Promise<ShopeeOrder[]>;
  /** Escrow (repasse estimado ou liberado) de até 50 pedidos. */
  escrowDetails(token: string, shopId: string, orderSns: string[]): Promise<ShopeeEscrowDetail[]>;
  /** Repasses liberados em [from, to] (no máximo 15 dias), em páginas. */
  escrowList(token: string, shopId: string, from: Date, to: Date, page: number): Promise<{ released: { orderSn: string; payout: number; releasedAt: Date }[]; more: boolean }>;
}

const API_HOST = 'https://partner.shopeemobile.com';
const AUTH_HOST = 'https://open.shopee.com.br';
export const SHOPEE_BATCH = 50;
const ESCROW_BATCH = 20; // a Shopee recomenda até 20 por chamada no lote de escrow
const PAGE_SIZE = 100;
const DETAIL_FIELDS = 'item_list,pay_time,total_amount,payment_method,fulfillment_flag';

/** HMAC-SHA256 da partner key sobre partner_id + caminho + timestamp (+ access_token + shop_id nas APIs da loja). */
export function signShopee(partnerKey: string, base: string): string {
  return createHmac('sha256', partnerKey).update(base).digest('hex');
}

const unix = (d: Date) => Math.floor(d.getTime() / 1000);

export class HttpShopeeApi implements ShopeeApi {
  constructor(private readonly opts: { partnerId: string; partnerKey: string; redirectUri: string; host?: string }) {}

  authorizationUrl(state: string): string {
    const q = new URLSearchParams({ partner_id: this.opts.partnerId, auth_type: 'seller', redirect_uri: this.opts.redirectUri, response_type: 'code', state });
    return `${AUTH_HOST}/auth?${q}`;
  }

  exchangeCode(code: string, owner: { shopId?: string; mainAccountId?: string }): Promise<ShopeeTokens> {
    const who = owner.shopId ? { shop_id: Number(owner.shopId) } : { main_account_id: Number(owner.mainAccountId) };
    return this.token('/api/v2/auth/token/get', { code, ...who }, owner.shopId);
  }

  refresh(refreshToken: string, shopId: string): Promise<ShopeeTokens> {
    return this.token('/api/v2/auth/access_token/get', { refresh_token: refreshToken, shop_id: Number(shopId) }, shopId);
  }

  private async token(path: string, body: Record<string, unknown>, shopId?: string): Promise<ShopeeTokens> {
    const d = await this.request<Record<string, unknown>>('POST', path, {}, { ...body, partner_id: Number(this.opts.partnerId) });
    const expireIn = Number(d.expire_in);
    if (!d.access_token || !d.refresh_token || !Number.isFinite(expireIn)) throw new ShopeeApiError('Resposta de token incompleta', 502, null);
    const list = Array.isArray(d.shop_id_list) ? (d.shop_id_list as unknown[]).map(String) : [];
    return {
      accessToken: String(d.access_token),
      refreshToken: String(d.refresh_token),
      accessExpiresAt: new Date(Date.now() + expireIn * 1000),
      shopIds: list.length ? list : shopId ? [shopId] : d.shop_id ? [String(d.shop_id)] : [],
    };
  }

  async shopInfo(token: string, shopId: string): Promise<ShopeeShopInfo> {
    const d = await this.shop<Record<string, unknown>>('GET', '/api/v2/shop/get_shop_info', token, shopId, {});
    const exp = Number(d.expire_time);
    return { name: String(d.shop_name ?? ''), region: String(d.region ?? ''), authExpiresAt: exp > 0 ? new Date(exp * 1000) : null };
  }

  async orderList(token: string, shopId: string, from: Date, to: Date, field: 'create_time' | 'update_time', cursor?: string) {
    const d = await this.shop<{ order_list?: { order_sn: string }[]; more?: boolean; next_cursor?: string }>('GET', '/api/v2/order/get_order_list', token, shopId, {
      time_range_field: field, time_from: String(unix(from)), time_to: String(unix(to)), page_size: String(PAGE_SIZE), cursor: cursor ?? '',
    });
    return { orderSns: (d.order_list ?? []).map((o) => o.order_sn), next: d.more && d.next_cursor ? d.next_cursor : null };
  }

  async orderDetails(token: string, shopId: string, orderSns: string[]): Promise<ShopeeOrder[]> {
    if (!orderSns.length) return [];
    const d = await this.shop<{ order_list?: ShopeeOrder[] }>('GET', '/api/v2/order/get_order_detail', token, shopId, {
      order_sn_list: orderSns.join(','), response_optional_fields: DETAIL_FIELDS,
    });
    return d.order_list ?? [];
  }

  /** Lote do escrow aceito pela Shopee? (a documentação diverge sobre o método; se recusar, vai pedido a pedido) */
  private batchOk = true;

  async escrowDetails(token: string, shopId: string, orderSns: string[]): Promise<ShopeeEscrowDetail[]> {
    const out: ShopeeEscrowDetail[] = [];
    for (let i = 0; i < orderSns.length; i += ESCROW_BATCH) {
      const chunk = orderSns.slice(i, i + ESCROW_BATCH);
      if (this.batchOk) {
        try {
          const d = await this.shop<unknown>('POST', '/api/v2/payment/get_escrow_detail_batch', token, shopId, {}, { order_sn_list: chunk });
          const list = (Array.isArray(d) ? d.flat() : []) as { escrow_detail?: ShopeeEscrowDetail }[];
          for (const x of list) if (x?.escrow_detail?.order_sn) out.push(x.escrow_detail);
          continue;
        } catch (err) {
          if (!(err instanceof ShopeeApiError) || !/param|method|not_found|404/i.test(`${err.code} ${err.status}`)) throw err;
          this.batchOk = false;
        }
      }
      for (const sn of chunk) {
        out.push(await this.shop<ShopeeEscrowDetail>('GET', '/api/v2/payment/get_escrow_detail', token, shopId, { order_sn: sn }));
      }
    }
    return out;
  }

  async escrowList(token: string, shopId: string, from: Date, to: Date, page: number) {
    const d = await this.shop<{ escrow_list?: { order_sn: string; payout_amount: number; escrow_release_time: number }[]; more?: boolean }>(
      'GET', '/api/v2/payment/get_escrow_list', token, shopId,
      { release_time_from: String(unix(from)), release_time_to: String(unix(to)), page_size: String(PAGE_SIZE), page_no: String(page) },
    );
    return {
      released: (d.escrow_list ?? []).map((e) => ({ orderSn: e.order_sn, payout: Number(e.payout_amount) || 0, releasedAt: new Date(e.escrow_release_time * 1000) })),
      more: Boolean(d.more),
    };
  }

  private shop<T>(method: 'GET' | 'POST', path: string, token: string, shopId: string, query: Record<string, string>, body?: unknown): Promise<T> {
    return this.request<T>(method, path, { ...query, access_token: token, shop_id: shopId }, body);
  }

  private async request<T>(method: 'GET' | 'POST', path: string, query: Record<string, string>, body?: unknown): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const base = this.opts.partnerId + path + timestamp + (query.access_token ?? '') + (query.shop_id ?? '');
      const q = new URLSearchParams({ ...query, partner_id: this.opts.partnerId, timestamp, sign: signShopee(this.opts.partnerKey, base) });
      const res = await fetch(`${this.opts.host ?? API_HOST}${path}?${q}`, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(30_000),
      });
      const json = (await res.json().catch(() => null)) as { error?: string; message?: string; response?: T } & Record<string, unknown> | null;
      // limite de requisições ou instabilidade: espera e tenta de novo (até 3 vezes)
      const throttled = res.status === 429 || res.status >= 500 || json?.error === 'error_rate_limit' || json?.error === 'error_server';
      if (throttled && attempt < 3) {
        await new Promise((r) => setTimeout(r, 2000 * (attempt + 1)));
        continue;
      }
      if (!res.ok || !json || json.error) {
        throw new ShopeeApiError(json?.message || json?.error || `Shopee respondeu ${res.status}`, res.status, json?.error || null);
      }
      // as rotas de token respondem na raiz; as demais, dentro de `response`
      return (json.response ?? json) as T;
    }
  }
}
