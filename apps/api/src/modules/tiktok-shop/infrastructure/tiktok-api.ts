import { createHmac } from 'node:crypto';
import type { TiktokFinanceTx, TiktokOrder } from '../domain/tiktok-order.js';
import type { TiktokProduct } from '../domain/tiktok-product.js';

export class TiktokApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: number | null) {
    super(message);
    this.name = 'TiktokApiError';
  }
}

export interface TiktokTokens {
  accessToken: string;
  refreshToken: string;
  accessExpiresAt: Date;
  refreshExpiresAt: Date | null;
  sellerName: string | null;
}

export interface TiktokShop {
  id: string;
  name: string;
  region: string;
  cipher: string;
}

export interface TiktokStatement {
  id: string;
  /** Segundos Unix. */
  statement_time: number;
}

export interface TiktokApi {
  authorizationUrl(state: string): string;
  exchangeCode(code: string): Promise<TiktokTokens>;
  refresh(refreshToken: string): Promise<TiktokTokens>;
  shops(token: string): Promise<TiktokShop[]>;
  /** Pedidos criados (`create`) ou alterados (`update`) em [from, to), em páginas. */
  searchOrders(token: string, cipher: string, from: Date, to: Date, by: 'create' | 'update', pageToken?: string): Promise<{ orders: TiktokOrder[]; next: string | null }>;
  /** Extratos (um por repasse ou ajuste) com `statement_time` a partir de `from`, do mais antigo para o mais novo. */
  statements(token: string, cipher: string, from: Date, pageToken?: string): Promise<{ statements: TiktokStatement[]; next: string | null }>;
  /** Transações de um extrato: repasse de cada pedido (com tarifas, frete e devolução) e ajustes. */
  statementTransactions(token: string, cipher: string, statementId: string, pageToken?: string): Promise<{ transactions: TiktokFinanceTx[]; next: string | null }>;
  /** Pedidos ainda sem repasse, com os valores ESTIMADOS pelo TikTok. */
  unsettled(token: string, cipher: string, pageToken?: string): Promise<{ transactions: TiktokFinanceTx[]; next: string | null }>;
  /** Catálogo da loja (todas as situações), em páginas. */
  searchProducts(token: string, cipher: string, pageToken?: string): Promise<{ products: TiktokProduct[]; next: string | null }>;
}

const AUTH_HOST = 'https://auth.tiktok-shops.com';
const API_HOST = 'https://open-api.tiktokglobalshop.com';
export const TIKTOK_PAGE_SIZE = 50;
const FINANCE_PAGE_SIZE = 100;
const PRODUCT_PAGE_SIZE = 100;

/**
 * Assinatura das chamadas (versões 202309+): HMAC-SHA256 de
 * segredo + caminho + parâmetros em ordem alfabética (sem `sign` e `access_token`) + corpo + segredo.
 */
export function signTiktok(secret: string, path: string, query: Record<string, string>, body = ''): string {
  const params = Object.keys(query)
    .filter((k) => k !== 'sign' && k !== 'access_token')
    .sort()
    .map((k) => k + query[k])
    .join('');
  return createHmac('sha256', secret).update(secret + path + params + body + secret).digest('hex');
}

/** As validades vêm como instante Unix absoluto; valor pequeno é tratado como duração em segundos. */
const expiry = (v: unknown): Date | null => {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return null;
  return new Date((n > 1_000_000_000 ? n : Date.now() / 1000 + n) * 1000);
};

export class HttpTiktokApi implements TiktokApi {
  constructor(private readonly opts: { appKey: string; appSecret: string; serviceId: string }) {}

  authorizationUrl(state: string): string {
    // o redirecionamento é o cadastrado no app (Partner Center); a URL não leva redirect_uri
    return `https://services.tiktokshop.com/open/authorize?${new URLSearchParams({ service_id: this.opts.serviceId, state })}`;
  }

  exchangeCode(code: string): Promise<TiktokTokens> {
    return this.token('/api/v2/token/get', { auth_code: code, grant_type: 'authorized_code' });
  }

  refresh(refreshToken: string): Promise<TiktokTokens> {
    return this.token('/api/v2/token/refresh', { refresh_token: refreshToken, grant_type: 'refresh_token' });
  }

  private async token(path: string, extra: Record<string, string>): Promise<TiktokTokens> {
    const qs = new URLSearchParams({ app_key: this.opts.appKey, app_secret: this.opts.appSecret, ...extra });
    const d = await this.read<Record<string, unknown>>(await fetch(`${AUTH_HOST}${path}?${qs}`, { signal: AbortSignal.timeout(20_000) }));
    const accessExpiresAt = expiry(d.access_token_expire_in);
    if (!d.access_token || !d.refresh_token || !accessExpiresAt) throw new TiktokApiError('Resposta de token incompleta', 502, null);
    return {
      accessToken: String(d.access_token),
      refreshToken: String(d.refresh_token),
      accessExpiresAt,
      refreshExpiresAt: expiry(d.refresh_token_expire_in),
      sellerName: d.seller_name ? String(d.seller_name) : null,
    };
  }

  async shops(token: string): Promise<TiktokShop[]> {
    const d = await this.call<{ shops?: TiktokShop[] }>('GET', '/authorization/202309/shops', token, {});
    return d.shops ?? [];
  }

  async searchOrders(token: string, cipher: string, from: Date, to: Date, by: 'create' | 'update', pageToken?: string) {
    const query: Record<string, string> = { shop_cipher: cipher, page_size: String(TIKTOK_PAGE_SIZE), sort_field: 'create_time', sort_order: 'ASC' };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ orders?: TiktokOrder[]; next_page_token?: string }>('POST', '/order/202309/orders/search', token, query, {
      [`${by}_time_ge`]: Math.floor(from.getTime() / 1000),
      [`${by}_time_lt`]: Math.floor(to.getTime() / 1000),
    });
    return { orders: d.orders ?? [], next: d.next_page_token || null };
  }

  async statements(token: string, cipher: string, from: Date, pageToken?: string) {
    const query: Record<string, string> = {
      shop_cipher: cipher, sort_field: 'statement_time', sort_order: 'ASC', page_size: String(FINANCE_PAGE_SIZE),
      statement_time_ge: String(Math.floor(from.getTime() / 1000)),
    };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ statements?: TiktokStatement[]; next_page_token?: string }>('GET', '/finance/202309/statements', token, query);
    return { statements: d.statements ?? [], next: d.next_page_token || null };
  }

  async statementTransactions(token: string, cipher: string, statementId: string, pageToken?: string) {
    const query: Record<string, string> = { shop_cipher: cipher, sort_field: 'order_create_time', page_size: String(FINANCE_PAGE_SIZE) };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ transactions?: TiktokFinanceTx[]; next_page_token?: string }>(
      'GET', `/finance/202501/statements/${encodeURIComponent(statementId)}/statement_transactions`, token, query,
    );
    return { transactions: d.transactions ?? [], next: d.next_page_token || null };
  }

  async unsettled(token: string, cipher: string, pageToken?: string) {
    const query: Record<string, string> = { shop_cipher: cipher, sort_field: 'order_create_time', sort_order: 'DESC', page_size: String(FINANCE_PAGE_SIZE) };
    if (pageToken) query.page_token = pageToken;
    const d = await this.call<{ transactions?: TiktokFinanceTx[]; next_page_token?: string }>('GET', '/finance/202507/orders/unsettled', token, query);
    return { transactions: d.transactions ?? [], next: d.next_page_token || null };
  }

  async searchProducts(token: string, cipher: string, pageToken?: string) {
    const query: Record<string, string> = { shop_cipher: cipher, page_size: String(PRODUCT_PAGE_SIZE) };
    if (pageToken) query.page_token = pageToken;
    // corpo vazio = todas as situações (ativo, desativado, congelado...)
    const d = await this.call<{ products?: TiktokProduct[]; next_page_token?: string }>('POST', '/product/202309/products/search', token, query, {});
    return { products: d.products ?? [], next: d.next_page_token || null };
  }

  private async call<T>(method: 'GET' | 'POST', path: string, token: string, query: Record<string, string>, body?: unknown): Promise<T> {
    const raw = body === undefined ? '' : JSON.stringify(body);
    const q: Record<string, string> = { ...query, app_key: this.opts.appKey, timestamp: String(Math.floor(Date.now() / 1000)) };
    q.sign = signTiktok(this.opts.appSecret, path, q, raw);
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API_HOST}${path}?${new URLSearchParams(q)}`, {
        method,
        headers: { 'x-tts-access-token': token, 'content-type': 'application/json' },
        body: raw || undefined,
        signal: AbortSignal.timeout(30_000),
      });
      // limite de requisições ou instabilidade: espera e tenta de novo (até 3 vezes)
      if ((res.status === 429 || res.status >= 500) && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      return this.read<T>(res);
    }
  }

  private async read<T>(res: Response): Promise<T> {
    const json = (await res.json().catch(() => null)) as { code?: number; message?: string; data?: T } | null;
    if (!res.ok || !json || json.code !== 0) {
      throw new TiktokApiError(json?.message ?? `TikTok Shop respondeu ${res.status}`, res.status, json?.code ?? null);
    }
    return (json.data ?? {}) as T;
  }
}
