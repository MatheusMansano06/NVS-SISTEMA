import type { MlItem, MlItemPromotion, MlOrder } from '../domain/ml-order.js';
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
/** Acesso genérico à API do ML (pós-venda). Implementado pelo HttpMlApi; os fakes de teste implementam o que usam. */
export interface MlRawApi {
  /** GET; 404/403 viram null (recurso indisponível para este vendedor/pedido). */
  rawGet<T>(token: string, path: string): Promise<T | null>;
  rawPost<T>(token: string, path: string, body: unknown): Promise<T>;
  rawPut<T>(token: string, path: string, body: unknown): Promise<T>;
  rawUpload<T>(token: string, path: string, file: { name: string; type: string; bytes: Buffer }): Promise<T>;
}

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
  /** Altera campos do anúncio (preço, estoque, status). Erros do ML viram MlApiError. */
  updateItem(token: string, itemId: string, body: Record<string, unknown>): Promise<MlItem>;
  /** Tarifa de venda por tipo de anúncio para um preço/categoria. */
  listingFees(token: string, price: number, categoryId: string | null): Promise<MlListingFee[]>;
  /** Custo de frete grátis bancado pelo vendedor (tabela do ML); null se indisponível. */
  freeShippingCost(token: string, sellerId: string, itemId: string): Promise<number | null>;
  /** Anúncio completo (atributos, fotos, envio) para o editor. */
  itemFull(token: string, itemId: string): Promise<MlItemFull>;
  /** Descrição em texto puro; null se o anúncio não tiver. */
  description(token: string, itemId: string): Promise<string | null>;
  setDescription(token: string, itemId: string, text: string): Promise<void>;
  /** Sobe uma imagem para o ML e devolve o id da foto. */
  uploadPicture(token: string, file: { name: string; type: string; bytes: Buffer }): Promise<{ id: string; url: string | null }>;
  /** Preços do anúncio (o "standard" é a base das faixas de atacado). */
  prices(token: string, itemId: string): Promise<{ id: string; type: string; amount: number; currency_id?: string }[]>;
  /** Preço que um comprador EMPRESA vê numa quantidade (contexto B2B). */
  businessPrice(token: string, itemId: string, quantity: number): Promise<number | null>;
  /** Grava as faixas de preço por quantidade (B2B). Lista só com o standard remove as faixas. */
  setQuantityPrices(token: string, itemId: string, prices: unknown[]): Promise<void>;
  /** Troca o tipo do anúncio (Clássico/Premium). */
  changeListingType(token: string, itemId: string, type: string): Promise<void>;
  /** Cria um anúncio (duplicação). */
  createItem(token: string, body: Record<string, unknown>): Promise<{ id: string; permalink?: string | null }>;
  /** Categorias sugeridas para um termo (domain_discovery). */
  searchCategories(token: string, q: string): Promise<{ category_id: string; category_name: string; domain_name?: string | null }[]>;
  /** Categorias raiz do site (MLB). */
  siteCategories(token: string): Promise<{ id: string; name: string }[]>;
  /** Categoria com o caminho desde a raiz e as filhas. */
  category(token: string, id: string): Promise<MlCategory>;
  /** Tamanho médio do pacote na categoria (cm/g); null se o ML não informar. */
  categoryDimensions(token: string, id: string): Promise<{ height: number; width: number; length: number; weight: number } | null>;
  /** Frete do vendedor para um pacote com essas medidas (com o desconto da reputação da conta). */
  freightByDimensions(
    token: string,
    sellerId: string,
    q: { dimensions: string; price: number; type: string; freeShipping: boolean; categoryId?: string | null },
  ): Promise<number | null>;
  /** Períodos (meses) de faturamento do ML, mais recentes primeiro. */
  billingPeriods(token: string): Promise<MlBillingPeriod[]>;
  /** Resumo da fatura do período: cobranças, bonificações e impostos. */
  billingSummary(token: string, key: string): Promise<MlBillingSummary>;
  /** Flex no anúncio: consultar, ativar (POST) e desativar (DELETE). */
  flexItem(token: string, itemId: string): Promise<boolean | null>;
  setFlexItem(token: string, itemId: string, enabled: boolean): Promise<void>;
  /** Assinaturas Flex do vendedor (uma por origem). */
  flexSubscriptions(token: string, userId: string): Promise<MlFlexSubscription[]>;
  flexZones(token: string, userId: string, serviceId: number): Promise<MlFlexZones | null>;
  flexRadius(token: string, userId: string, serviceId: number): Promise<number | null>;
  /** A categoria aceita Flex (self_service nas logísticas ME2)? null se o ML não informar. */
  categoryAllowsFlex(token: string, categoryId: string): Promise<boolean | null>;
  /** Promoções em que o anúncio está (para o bônus de tarifa). */
  itemPromotions(token: string, itemId: string): Promise<MlItemPromotion[]>;
  /** Campanhas da Central de Promoções do vendedor. */
  promotions(token: string, sellerId: string): Promise<MlPromotion[]>;
  /** Anúncios elegíveis e ainda fora da campanha (status=candidate), paginados por `searchAfter`. */
  promotionCandidates(
    token: string,
    promotionId: string,
    type: string,
    searchAfter: string | null,
  ): Promise<{ results: MlPromotionItem[]; searchAfter: string | null }>;
  /** Inscreve o anúncio na campanha (escreve no ML). */
  enrollPromotion(token: string, itemId: string, body: { promotion_id: string; promotion_type: string; deal_price?: number }): Promise<void>;
  /** Mercado Ads (Product Ads): anunciante da conta. Lança 401/403 sem permissão de publicidade. */
  adAdvertisers?(token: string): Promise<{ advertiserId: string; siteId: string }[]>;
  /** Mercado Ads: custo total das campanhas num dia (YYYY-MM-DD). O ML guarda 90 dias para trás. */
  adCost?(token: string, advertiserId: string, siteId: string, day: string): Promise<number>;
  /** Mercado Ads: todas as campanhas (configuração atual) com as métricas de um dia. */
  adCampaigns?(token: string, advertiserId: string, siteId: string, day: string): Promise<MlAdCampaign[]>;
  /** Mercado Ads: todos os anúncios patrocinados (campanha atual) com as métricas de um dia. */
  adItems?(token: string, advertiserId: string, siteId: string, day: string): Promise<MlAdItem[]>;
}

/** Métricas do Mercado Ads (as que o Radar ADS guarda; as taxas são recalculadas a partir delas). */
export interface MlAdMetrics {
  cost?: number | null;
  clicks?: number | null;
  prints?: number | null;
  direct_amount?: number | null;
  indirect_amount?: number | null;
  units_quantity?: number | null;
  organic_units_quantity?: number | null;
  organic_units_amount?: number | null;
  lost_impression_share_by_budget?: number | null;
}

export interface MlAdCampaign {
  id: number;
  name: string;
  status: string;
  strategy?: string | null;
  acos_target?: number | null;
  roas_target?: number | null;
  budget?: number | null;
  daily_budget?: number | null;
  automatic_budget?: boolean | null;
  last_updated?: string | null;
  metrics?: MlAdMetrics | null;
}

export interface MlAdItem {
  item_id: string;
  campaign_id?: number | null;
  title?: string | null;
  status?: string | null;
  price?: number | null;
  thumbnail?: string | null;
  logistic_type?: string | null;
  metrics?: MlAdMetrics | null;
}

export interface MlFlexSubscription {
  service_id: number;
  mode?: string | null;
  status?: string | null;
  origin?: { city?: { name?: string | null } | null; zip_code?: string | null; id?: string | null } | null;
  configuration?: { set?: { coverage?: { type?: string | null } | null } | null } | null;
}

export interface MlFlexPrice {
  price?: { fraction?: string | null; cents?: string | null } | null;
  weight?: { from_kg?: number | null; to_kg?: number | null } | null;
}

export interface MlFlexZones {
  zones?: { id: string }[] | null;
  availables?: {
    zones?: {
      id: string;
      label?: string | null;
      polygon?: { geometry?: { type?: string; coordinates?: unknown } | null } | null;
      pricing?: { prices?: MlFlexPrice[] | null } | null;
    }[] | null;
  } | null;
}

export interface MlBillingPeriod {
  key: string;
  amount?: number | null;
  period?: { date_from?: string | null; date_to?: string | null } | null;
  period_status?: string | null;
}

export interface MlBillingLine {
  label?: string | null;
  amount?: number | null;
  type?: string | null;
}

export interface MlBillingSummary {
  period?: { date_from?: string | null; date_to?: string | null; key?: string | null } | null;
  bill_includes?: { total_amount?: number | null; charges?: MlBillingLine[] | null; bonuses?: MlBillingLine[] | null } | null;
}

export interface MlCategory {
  id: string;
  name: string;
  path_from_root?: { id: string; name: string }[] | null;
  children_categories?: { id: string; name: string }[] | null;
}

export interface MlItemFull {
  id: string;
  title: string;
  status: string;
  price?: number | null;
  category_id?: string | null;
  currency_id?: string | null;
  buying_mode?: string | null;
  listing_type_id?: string | null;
  condition?: string | null;
  available_quantity?: number | null;
  sale_terms?: { id: string; value_name?: string | null }[] | null;
  variations?: {
    attribute_combinations?: unknown[] | null;
    available_quantity?: number | null;
    price?: number | null;
    attributes?: { id: string; value_id?: string | null; value_name?: string | null }[] | null;
  }[] | null;
  attributes?: { id: string; name?: string | null; value_id?: string | null; value_name?: string | null; value_type?: string | null }[] | null;
  pictures?: { id: string; secure_url?: string | null; url?: string | null }[] | null;
  shipping?: {
    logistic_type?: string | null;
    tags?: string[] | null;
    free_shipping?: boolean | null;
    mode?: string | null;
    local_pick_up?: boolean | null;
  } | null;
  catalog_listing?: boolean | null;
}

export interface MlPromotion {
  id: string;
  type: string;
  name?: string | null;
  status?: string | null;
  start_date?: string | null;
  finish_date?: string | null;
}

export interface MlPromotionItem {
  id: string;
  original_price?: number | null;
  price?: number | null;
  suggested_discounted_price?: number | null;
  min_discounted_price?: number | null;
  max_discounted_price?: number | null;
  meli_percentage?: number | null;
  seller_percentage?: number | null;
}

export interface MlListingFee {
  listing_type_id: string;
  sale_fee_amount: number;
  sale_fee_details?: { percentage_fee?: number; fixed_fee?: number } | null;
}

export class MlApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

const API = 'https://api.mercadolibre.com';
const AUTH = 'https://auth.mercadolivre.com.br/authorization';
/** Métricas do Mercado Ads pedidas nas buscas do Radar ADS (as mesmas em campanhas e anúncios). */
const AD_METRICS = 'cost,clicks,prints,direct_amount,indirect_amount,units_quantity,organic_units_quantity,organic_units_amount';
const AD_BASE_METRICS = 'cost,clicks,prints,direct_amount,indirect_amount';
export const ORDERS_PAGE_SIZE = 50;
export const LISTINGS_PAGE_SIZE = 100;

interface Config {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class HttpMlApi implements MlApi, MlRawApi {
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
        'id,title,status,sub_status,price,available_quantity,permalink,secure_thumbnail,thumbnail,pictures,seller_custom_field,attributes,variations,sold_quantity,listing_type_id,category_id,date_created,catalog_listing,shipping,original_price',
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

  updateItem(token: string, itemId: string, body: Record<string, unknown>) {
    return this.request<MlItem>(
      `/items/${encodeURIComponent(itemId)}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      false,
    );
  }

  listingFees(token: string, price: number, categoryId: string | null) {
    const qs = new URLSearchParams({ price: String(price) });
    if (categoryId) qs.set('category_id', categoryId);
    return this.get<MlListingFee[]>(`/sites/MLB/listing_prices?${qs}`, token);
  }

  async freeShippingCost(token: string, sellerId: string, itemId: string) {
    const r = await this.optional(() =>
      this.get<{ coverage?: { all_country?: { list_cost?: number } } }>(
        `/users/${encodeURIComponent(sellerId)}/shipping_options/free?item_id=${encodeURIComponent(itemId)}&verbose=true`,
        token,
      ),
    );
    return r?.coverage?.all_country?.list_cost ?? null;
  }

  itemFull(token: string, itemId: string) {
    return this.get<MlItemFull>(`/items/${encodeURIComponent(itemId)}?include_attributes=all`, token);
  }

  async description(token: string, itemId: string) {
    const r = await this.optional(() => this.get<{ plain_text?: string | null }>(`/items/${encodeURIComponent(itemId)}/description`, token));
    return r?.plain_text ?? null;
  }

  async setDescription(token: string, itemId: string, text: string) {
    await this.send('PUT', `/items/${encodeURIComponent(itemId)}/description`, token, { plain_text: text });
  }

  async uploadPicture(token: string, file: { name: string; type: string; bytes: Buffer }) {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    const r = await this.request<{ id: string; variations?: { secure_url?: string; url?: string }[] }>(
      '/pictures/items/upload',
      { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, body: form },
      false,
    );
    return { id: r.id, url: r.variations?.[0]?.secure_url ?? r.variations?.[0]?.url ?? null };
  }

  async prices(token: string, itemId: string) {
    const r = await this.get<{ prices?: { id: string; type: string; amount: number; currency_id?: string }[] }>(
      `/items/${encodeURIComponent(itemId)}/prices`,
      token,
    );
    return r.prices ?? [];
  }

  async businessPrice(token: string, itemId: string, quantity: number) {
    const qs = new URLSearchParams({ context: 'channel_marketplace,user_type_business', quantity: String(quantity) });
    const r = await this.optional(() => this.get<{ amount?: number | null }>(`/items/${encodeURIComponent(itemId)}/sale_price?${qs}`, token));
    return r?.amount ?? null;
  }

  async setQuantityPrices(token: string, itemId: string, prices: unknown[]) {
    await this.send('POST', `/items/${encodeURIComponent(itemId)}/prices/standard/quantity`, token, { prices });
  }

  async flexItem(token: string, itemId: string) {
    const r = await this.optional(() => this.get<{ has_flex?: boolean }>(`/flex/sites/MLB/items/${encodeURIComponent(itemId)}/v2`, token));
    return r ? Boolean(r.has_flex) : null;
  }

  async setFlexItem(token: string, itemId: string, enabled: boolean) {
    await this.request<unknown>(
      `/flex/sites/MLB/items/${encodeURIComponent(itemId)}/v2`,
      { method: enabled ? 'POST' : 'DELETE', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      false,
    );
  }

  async flexSubscriptions(token: string, userId: string) {
    const r = await this.optional(() => this.get<MlFlexSubscription[]>(`/flex/sites/MLB/users/${encodeURIComponent(userId)}/subscriptions/v1`, token));
    return r ?? [];
  }

  flexZones(token: string, userId: string, serviceId: number) {
    return this.optional(() =>
      this.get<MlFlexZones>(
        `/flex/sites/MLB/users/${encodeURIComponent(userId)}/services/${serviceId}/configurations/coverage/zones/v1?show_availables=true`,
        token,
      ),
    );
  }

  async flexRadius(token: string, userId: string, serviceId: number) {
    const r = await this.optional(() =>
      this.get<{ radius?: number | null }>(
        `/flex/sites/MLB/users/${encodeURIComponent(userId)}/services/${serviceId}/configurations/coverage/radius/v1`,
        token,
      ),
    );
    return r?.radius ?? null;
  }

  async categoryAllowsFlex(token: string, categoryId: string) {
    const r = await this.optional(() =>
      this.get<{ logistics?: { mode?: string; types?: string[] }[] | null }>(`/categories/${encodeURIComponent(categoryId)}/shipping_preferences`, token),
    );
    if (!r?.logistics) return null;
    return r.logistics.some((l) => l.mode === 'me2' && (l.types ?? []).includes('self_service'));
  }

  async billingPeriods(token: string) {
    const r = await this.get<{ results?: MlBillingPeriod[] }>(
      '/billing/integration/monthly/periods?group=ML&document_type=BILL&offset=0&limit=12',
      token,
    );
    return r.results ?? [];
  }

  billingSummary(token: string, key: string) {
    return this.get<MlBillingSummary>(`/billing/integration/periods/key/${encodeURIComponent(key)}/summary/details?group=ML&document_type=BILL`, token);
  }

  async siteCategories(token: string) {
    return this.get<{ id: string; name: string }[]>('/sites/MLB/categories', token);
  }

  category(token: string, id: string) {
    return this.get<MlCategory>(`/categories/${encodeURIComponent(id)}`, token);
  }

  async categoryDimensions(token: string, id: string) {
    const r = await this.optional(() =>
      this.get<{ dimensions?: { height?: number; width?: number; length?: number; weight?: number } | null }>(
        `/categories/${encodeURIComponent(id)}/shipping_preferences`,
        token,
      ),
    );
    const d = r?.dimensions;
    return d?.height && d.width && d.length && d.weight
      ? { height: d.height, width: d.width, length: d.length, weight: d.weight }
      : null;
  }

  async freightByDimensions(
    token: string,
    sellerId: string,
    q: { dimensions: string; price: number; type: string; freeShipping: boolean; categoryId?: string | null },
  ) {
    const qs = new URLSearchParams({
      dimensions: q.dimensions,
      verbose: 'true',
      item_price: String(q.price),
      listing_type_id: q.type,
      mode: 'me2',
      condition: 'new',
      logistic_type: 'drop_off',
      free_shipping: q.freeShipping ? 'True' : 'False',
    });
    if (q.categoryId) qs.set('category_id', q.categoryId);
    const r = await this.optional(() =>
      this.get<{ coverage?: { all_country?: { list_cost?: number } } }>(
        `/users/${encodeURIComponent(sellerId)}/shipping_options/free?${qs}`,
        token,
      ),
    );
    return r?.coverage?.all_country?.list_cost ?? null;
  }

  async itemPromotions(token: string, itemId: string) {
    const r = await this.optional(() =>
      this.get<MlItemPromotion[] | { results?: MlItemPromotion[] }>(
        `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`,
        token,
      ),
    );
    if (!r) return [];
    return Array.isArray(r) ? r : (r.results ?? []);
  }

  async changeListingType(token: string, itemId: string, type: string) {
    await this.send('POST', `/items/${encodeURIComponent(itemId)}/listing_type`, token, { id: type });
  }

  async createItem(token: string, body: Record<string, unknown>) {
    return (await this.send('POST', '/items', token, body)) as { id: string; permalink?: string | null };
  }

  async searchCategories(token: string, q: string) {
    const qs = new URLSearchParams({ q, limit: '8' });
    return this.get<{ category_id: string; category_name: string; domain_name?: string | null }[]>(
      `/sites/MLB/domain_discovery/search?${qs}`,
      token,
    );
  }

  private send(method: string, path: string, token: string, body: unknown) {
    return this.request<unknown>(
      path,
      {
        method,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      false,
    );
  }

  async promotions(token: string, sellerId: string) {
    const r = await this.get<{ results?: MlPromotion[] }>(
      `/seller-promotions/users/${encodeURIComponent(sellerId)}?app_version=v2`,
      token,
    );
    return r.results ?? [];
  }

  async promotionCandidates(token: string, promotionId: string, type: string, searchAfter: string | null) {
    const qs = new URLSearchParams({ promotion_type: type, app_version: 'v2', status: 'candidate', limit: '50' });
    if (searchAfter) qs.set('search_after', searchAfter);
    const r = await this.get<{ results?: MlPromotionItem[]; paging?: { searchAfter?: string | null } }>(
      `/seller-promotions/promotions/${encodeURIComponent(promotionId)}/items?${qs}`,
      token,
    );
    return { results: r.results ?? [], searchAfter: r.paging?.searchAfter ?? null };
  }

  async enrollPromotion(token: string, itemId: string, body: { promotion_id: string; promotion_type: string; deal_price?: number }) {
    await this.request<unknown>(
      `/seller-promotions/items/${encodeURIComponent(itemId)}?app_version=v2`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
      false,
    );
  }

  // ---- Mercado Ads (Product Ads)
  async adAdvertisers(token: string): Promise<{ advertiserId: string; siteId: string }[]> {
    try {
      const r = await this.request<{ advertisers?: { advertiser_id: number | string; site_id: string }[] }>('/advertising/advertisers?product_id=PADS', {
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', 'api-version': '1' },
      });
      return (r.advertisers ?? []).map((a) => ({ advertiserId: String(a.advertiser_id), siteId: a.site_id }));
    } catch (err) {
      if (err instanceof MlApiError && err.status === 404) return []; // conta que nunca anunciou
      throw err; // 401/403 = o app não tem permissão de publicidade
    }
  }

  async adCost(token: string, advertiserId: string, siteId: string, day: string): Promise<number> {
    type Page = { metrics_summary?: { cost?: number }; results?: { metrics?: { cost?: number } }[]; paging?: { total?: number } };
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'api-version': '2' };
    const q = (offset: number) => `date_from=${day}&date_to=${day}&metrics=cost&metrics_summary=true&limit=50&offset=${offset}`;
    // rota nova (com o site) e, se não existir, a antiga
    const paths = [
      (o: number) => `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search?${q(o)}`,
      (o: number) => `/advertising/advertisers/${advertiserId}/product_ads/campaigns?${q(o)}`,
    ];
    for (const path of paths) {
      let first: Page;
      try {
        first = await this.request<Page>(path(0), { headers });
      } catch (err) {
        if (err instanceof MlApiError && err.status === 404) continue;
        throw err;
      }
      if (typeof first.metrics_summary?.cost === 'number') return first.metrics_summary.cost;
      // sem resumo: soma as campanhas de todas as páginas
      let total = (first.results ?? []).reduce((s, c) => s + Number(c.metrics?.cost ?? 0), 0);
      for (let o = 50; o < (first.paging?.total ?? 0); o += 50) {
        const page = await this.request<Page>(path(o), { headers });
        total += (page.results ?? []).reduce((s, c) => s + Number(c.metrics?.cost ?? 0), 0);
      }
      return total;
    }
    return 0;
  }

  adCampaigns(token: string, advertiserId: string, siteId: string, day: string): Promise<MlAdCampaign[]> {
    return this.adSearch<MlAdCampaign>(token, `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/campaigns/search`, day, AD_METRICS);
  }

  adItems(token: string, advertiserId: string, siteId: string, day: string): Promise<MlAdItem[]> {
    return this.adSearch<MlAdItem>(token, `/advertising/${siteId}/advertisers/${advertiserId}/product_ads/ads/search`, day, AD_METRICS);
  }

  /** Métricas que o ML aceitou em cada busca (descobertas na primeira recusa; valem enquanto o processo vive). */
  private readonly adMetricsOk = new Map<string, string>();

  /** Busca paginada (50 por página) do Mercado Ads com as métricas de um dia. */
  private async adSearch<T>(token: string, path: string, day: string, wanted: string): Promise<T[]> {
    const headers = { authorization: `Bearer ${token}`, accept: 'application/json', 'api-version': '2' };
    const kind = path.endsWith('/campaigns/search') ? 'campaigns' : 'ads';
    const out: T[] = [];
    for (let offset = 0; ; offset += 50) {
      const url = (m: string, limit = 50) => `${path}?limit=${limit}&offset=${offset}&date_from=${day}&date_to=${day}&metrics=${m}`;
      type Page = { results?: T[]; paging?: { total?: number } };
      const metrics = this.adMetricsOk.get(kind) ?? wanted;
      const page = await this.request<Page>(url(metrics), { headers }).catch(async (err) => {
        if (!(err instanceof MlApiError && err.status === 400) || this.adMetricsOk.has(kind)) throw err;
        // 400 = alguma métrica recusada: testa uma a uma sobre as básicas e fica só com as aceitas (sem perder orgânico e unidades)
        const extra = wanted.split(',').filter((m) => !AD_BASE_METRICS.split(',').includes(m));
        const ok = [AD_BASE_METRICS];
        for (const m of extra) {
          const accepted = await this.request<Page>(url(`${AD_BASE_METRICS},${m}`, 1), { headers }).then(() => true, () => false);
          if (accepted) ok.push(m);
        }
        this.adMetricsOk.set(kind, ok.join(','));
        console.warn(`Mercado Ads (${kind}): métricas recusadas pelo ML: ${extra.filter((m) => !ok.includes(m)).join(', ') || 'nenhuma'} — ${err.message}`);
        return this.request<Page>(url(this.adMetricsOk.get(kind)!), { headers });
      });
      out.push(...(page.results ?? []));
      if (!page.results?.length || offset + 50 >= (page.paging?.total ?? 0)) return out;
    }
  }

  // ---- chamadas genéricas (pós-venda: reclamações, devoluções, revisões, mediação) — ver MlRawApi
  rawGet<T>(token: string, path: string): Promise<T | null> {
    return this.optional(() => this.get<T>(path, token));
  }

  rawPost<T>(token: string, path: string, body: unknown): Promise<T> {
    return this.send('POST', path, token, body) as Promise<T>;
  }

  rawPut<T>(token: string, path: string, body: unknown): Promise<T> {
    return this.send('PUT', path, token, body) as Promise<T>;
  }

  async rawUpload<T>(token: string, path: string, file: { name: string; type: string; bytes: Buffer }): Promise<T> {
    const form = new FormData();
    form.append('file', new Blob([new Uint8Array(file.bytes)], { type: file.type }), file.name);
    return this.request<T>(path, { method: 'POST', headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, body: form }, false);
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
      if (res.ok) {
        const text = await res.text();
        return (text ? JSON.parse(text) : undefined) as T; // algumas escritas respondem sem corpo
      }
      if ((res.status === 429 || res.status >= 500) && attempt < attempts) {
        await sleep(500 * 2 ** attempt);
        continue;
      }
      const raw = await res.text().catch(() => '');
      let body: { message?: string; error?: string } = {};
      try {
        body = JSON.parse(raw) as typeof body;
      } catch {
        /* corpo vazio ou não-JSON */
      }
      // sem message/error: leva o corpo cru para o log mostrar o motivo do ML
      throw new MlApiError(body.message || body.error || `HTTP ${res.status}${raw ? `: ${raw.slice(0, 300)}` : ''}`, res.status, body.error);
    }
  }
}
