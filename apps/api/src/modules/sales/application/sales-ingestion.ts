import type { Marketplace } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { PgSkuRepository } from '../infrastructure/pg-sku-repository.js';
import { retentionCutoff } from './sales-retention.js';

/** Pedido já normalizado por um módulo de integração (independente do marketplace). */
export interface IncomingOrder {
  externalId: string;
  status: 'paid' | 'cancelled' | 'returned';
  orderedAt: string;
  gross: number;
  fee: number;
  units: number;
  shippingRef: string | null;
  /** Frete pago pelo comprador visto nos pagamentos (o envio pode refinar depois). */
  buyerShipping: number;
  refundPartial: number;
  /** Desconto bancado pelo vendedor já conhecido no pedido (TikTok Shop). No Mercado Livre o cupom vem depois, pelo enriquecimento. */
  couponSeller?: number;
  listingType: string | null;
  buyerNickname?: string | null;
  packId?: string | null;
  paymentType?: string | null;
  installments?: number | null;
  items: { sku: string; title: string; quantity: number; unitPrice: number; listingId: string | null; pictureUrl?: string | null }[];
}

/** Anúncio normalizado (foto, status, estoque). */
export interface IncomingListing {
  externalId: string;
  sku: string | null;
  variationSkus: string[];
  title: string;
  pictureUrl: string | null;
  permalink: string | null;
  price: number | null;
  availableQuantity: number | null;
  status: string;
  subStatus: string[];
  soldQuantity: number | null;
  listingTypeId: string | null;
  categoryId: string | null;
  freeShipping: boolean;
  logisticType: string | null;
  flexEnabled?: boolean;
  catalogListing: boolean;
  picturesCount: number | null;
  dimensions: string | null;
  listedAt: string | null;
  originalPrice: number | null;
  feeBonus: number | null;
  promoName: string | null;
}

/**
 * Porta pública do módulo de vendas para integrações gravarem pedidos.
 * Idempotente: reimportar o mesmo pedido atualiza em vez de duplicar.
 * Recebe o client já escopado ao tenant (RLS).
 */
export class SalesIngestion {
  private readonly skus = new PgSkuRepository();

  async upsertOrders(
    db: Queryable,
    tenantId: string,
    accountId: string,
    marketplace: Marketplace,
    orders: IncomingOrder[],
  ): Promise<number> {
    const orderIds: string[] = [];
    // meses já arquivados em totais não recebem pedidos de volta (seriam contados duas vezes)
    const cutoff = new Date(`${retentionCutoff()}T03:00:00Z`).getTime(); // meia-noite de São Paulo
    for (const o of orders) {
      if (new Date(o.orderedAt).getTime() < cutoff) continue;
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at,
                             gross_amount, marketplace_fee, units, shipping_ref, buyer_shipping, refund_partial, listing_type,
                             buyer_nickname, pack_id, payment_type, installments, coupon_seller)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, coalesce($18::numeric, 0))
         ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE
           SET status = EXCLUDED.status, ordered_at = EXCLUDED.ordered_at,
               gross_amount = EXCLUDED.gross_amount,
               -- TikTok Shop: a tarifa já conferida no repasse não volta para a estimativa
               marketplace_fee = CASE WHEN orders.marketplace = 'tiktok_shop' AND orders.finance_enriched_at IS NOT NULL
                                      THEN orders.marketplace_fee ELSE EXCLUDED.marketplace_fee END,
               units = EXCLUDED.units, shipping_ref = EXCLUDED.shipping_ref, account_id = EXCLUDED.account_id,
               -- TikTok Shop: a devolução conferida no extrato também não volta a zero na reimportação
               refund_partial = CASE WHEN orders.marketplace = 'tiktok_shop' AND orders.finance_enriched_at IS NOT NULL
                                     THEN orders.refund_partial ELSE EXCLUDED.refund_partial END,
               listing_type = EXCLUDED.listing_type,
               coupon_seller = CASE WHEN $18::numeric IS NULL THEN orders.coupon_seller ELSE $18::numeric END,
               buyer_nickname = COALESCE(EXCLUDED.buyer_nickname, orders.buyer_nickname),
               pack_id = COALESCE(EXCLUDED.pack_id, orders.pack_id),
               payment_type = COALESCE(EXCLUDED.payment_type, orders.payment_type),
               installments = COALESCE(EXCLUDED.installments, orders.installments),
               -- fretes já calculados pelo envio (rateados em pacote) não são sobrescritos
               buyer_shipping = CASE WHEN orders.finance_enriched_at IS NULL THEN EXCLUDED.buyer_shipping ELSE orders.buyer_shipping END
         RETURNING id`,
        [tenantId, accountId, marketplace, o.externalId, o.status, o.orderedAt, o.gross, o.fee, o.units, o.shippingRef,
         o.buyerShipping, o.refundPartial, o.listingType, o.buyerNickname ?? null, o.packId ?? null,
         o.paymentType ?? null, o.installments ?? null, o.couponSeller ?? null],
      );
      const orderId = rows[0]!.id;
      orderIds.push(orderId);
      await db.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
      for (const it of o.items) {
        await db.query(
          `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, listing_id, picture_url)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [tenantId, orderId, it.sku, it.title, it.quantity, it.unitPrice, it.listingId, it.pictureUrl ?? null],
        );
      }
    }
    // custo e imposto vigentes na data de cada venda (cadastro de SKUs)
    await this.skus.applyCosts(db, { orderIds });
    return orders.length;
  }

  /** Pedidos ainda sem fretes/cupom calculados (enriquecimento financeiro). */
  async pendingEnrichment(db: Queryable, accountId: string, sinceIso: string, limit = 5000, externalId?: string) {
    const { rows } = await db.query<{ id: string; external_id: string; shipping_ref: string | null; buyer_shipping: string }>(
      `SELECT id, external_id, shipping_ref, buyer_shipping FROM orders
        WHERE account_id = $1 AND ordered_at >= $2
          AND (CASE WHEN $4::text IS NULL THEN finance_enriched_at IS NULL ELSE external_id = $4 END)
        ORDER BY ordered_at DESC LIMIT $3`,
      [accountId, sinceIso, limit, externalId ?? null],
    );
    return rows.map((r) => ({ id: r.id, externalId: r.external_id, shippingRef: r.shipping_ref, buyerShipping: Number(r.buyer_shipping) }));
  }

  /**
   * Grava os fretes do ENVIO rateados entre os pedidos que o compartilham (pacote) e recalcula
   * imposto/custos (o cupom reduz a base do imposto).
   */
  async setShipmentFinance(
    db: Queryable,
    shippingRef: string,
    f: { buyer: number; seller: number; listCost?: number; bucket: string; uncertain: boolean; paidKnown?: boolean },
  ): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `WITH pack AS (SELECT id FROM orders WHERE shipping_ref = $1),
            n AS (SELECT count(*)::numeric AS c FROM pack)
       UPDATE orders o SET buyer_shipping = round($2 / n.c, 2), shipping_cost = round($3 / n.c, 2),
              logistic_bucket = $4, freight_uncertain = $5, finance_enriched_at = now(),
              shipping_list_cost = CASE WHEN $6::numeric IS NULL THEN o.shipping_list_cost ELSE round($6 / n.c, 2) END,
              freight_checked_at = CASE WHEN $7 THEN now() ELSE o.freight_checked_at END
         FROM n WHERE o.id IN (SELECT id FROM pack)
       RETURNING o.id`,
      [shippingRef, f.buyer, f.seller, f.bucket, f.uncertain, f.listCost ?? null, f.paidKnown ?? false],
    );
    return rows.map((r) => r.id);
  }

  /** Destino do envio para todos os pedidos do pacote (marca como consultado mesmo sem endereço). */
  async setShipmentAddress(
    db: Queryable,
    shippingRef: string,
    a: { uf: string | null; city: string | null; zip: string | null; lat?: number | null; lng?: number | null },
  ) {
    await db.query(
      `UPDATE orders SET ship_state = coalesce($2, ship_state), ship_city = coalesce($3, ship_city),
              ship_zip = coalesce($4, ship_zip), ship_lat = coalesce($5, ship_lat), ship_lng = coalesce($6, ship_lng),
              address_checked_at = now()
        WHERE shipping_ref = $1`,
      [shippingRef, a.uf, a.city, a.zip, a.lat ?? null, a.lng ?? null],
    );
  }

  /**
   * Envios já enriquecidos (90 dias, frete grátis, fora do Flex) cujo frete ainda é o de tabela:
   * precisam do valor cobrado de fato (senders.cost).
   */
  async pendingPaidFreight(db: Queryable, accountId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query<{ shipping_ref: string }>(
      `SELECT shipping_ref FROM orders
        WHERE account_id = $1 AND freight_checked_at IS NULL AND shipping_ref IS NOT NULL AND finance_enriched_at IS NOT NULL
          AND coalesce(buyer_shipping, 0) = 0 AND shipping_cost > 0 AND logistic_bucket IS DISTINCT FROM 'flex'
          AND ordered_at > now() - interval '90 days'
        GROUP BY shipping_ref ORDER BY max(ordered_at) DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => r.shipping_ref);
  }

  /** Grava o frete cobrado de fato (rateado no pacote); a tabela antiga vira shipping_list_cost. */
  async setPaidFreight(db: Queryable, shippingRef: string, paid: number | null, listCost: number | null): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `WITH pack AS (SELECT id, shipping_cost FROM orders WHERE shipping_ref = $1),
            n AS (SELECT count(*)::numeric AS c, sum(shipping_cost) AS old FROM pack)
       UPDATE orders o SET shipping_list_cost = CASE WHEN $2::numeric IS NULL THEN NULL ELSE round(coalesce($3, n.old) / n.c, 2) END,
              shipping_cost = CASE WHEN $2::numeric IS NULL THEN o.shipping_cost ELSE round($2 / n.c, 2) END,
              freight_checked_at = now()
         FROM n WHERE o.id IN (SELECT id FROM pack)
       RETURNING o.id`,
      [shippingRef, paid, listCost],
    );
    return rows.map((r) => r.id);
  }

  /** Envios de pedidos (mais recentes primeiro) ainda sem endereço consultado. */
  async pendingAddresses(db: Queryable, accountId: string, limit: number): Promise<string[]> {
    const { rows } = await db.query<{ shipping_ref: string }>(
      `SELECT shipping_ref FROM orders
        WHERE account_id = $1 AND address_checked_at IS NULL AND shipping_ref IS NOT NULL
        GROUP BY shipping_ref ORDER BY max(ordered_at) DESC LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => r.shipping_ref);
  }

  async setCoupon(db: Queryable, orderId: string, coupon: number, markEnriched: boolean): Promise<void> {
    await db.query(
      `UPDATE orders SET coupon_seller = $2, finance_enriched_at = CASE WHEN $3 THEN now() ELSE finance_enriched_at END WHERE id = $1`,
      [orderId, coupon, markEnriched],
    );
  }

  /** Recalcula custo/imposto dos pedidos (após cupom/fretes). */
  async recompute(db: Queryable, orderIds: string[]): Promise<void> {
    await this.skus.applyCosts(db, { orderIds });
  }

  async upsertListings(
    db: Queryable,
    tenantId: string,
    accountId: string,
    marketplace: Marketplace,
    listings: IncomingListing[],
  ): Promise<void> {
    for (const l of listings) {
      await db.query(
        `INSERT INTO listings (tenant_id, account_id, marketplace, external_id, title, picture_url, permalink,
                               price, available_quantity, status, sub_status, sku, variation_skus,
                               sold_quantity, listing_type_id, category_id, free_shipping, logistic_type,
                               catalog_listing, pictures_count, dimensions, listed_at,
                               original_price, fee_bonus, promo_name, flex_enabled, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13,
                 $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25, $26, now())
         ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE
           SET title = EXCLUDED.title, picture_url = COALESCE(EXCLUDED.picture_url, listings.picture_url),
               permalink = EXCLUDED.permalink, price = EXCLUDED.price,
               available_quantity = EXCLUDED.available_quantity, status = EXCLUDED.status,
               sub_status = EXCLUDED.sub_status, account_id = EXCLUDED.account_id,
               sku = EXCLUDED.sku, variation_skus = EXCLUDED.variation_skus,
               sold_quantity = EXCLUDED.sold_quantity, listing_type_id = EXCLUDED.listing_type_id,
               category_id = EXCLUDED.category_id, free_shipping = EXCLUDED.free_shipping,
               logistic_type = EXCLUDED.logistic_type, catalog_listing = EXCLUDED.catalog_listing,
               pictures_count = EXCLUDED.pictures_count, dimensions = EXCLUDED.dimensions,
               listed_at = EXCLUDED.listed_at, original_price = EXCLUDED.original_price,
               fee_bonus = EXCLUDED.fee_bonus, promo_name = EXCLUDED.promo_name, flex_enabled = EXCLUDED.flex_enabled,
               updated_at = now()`,
        [tenantId, accountId, marketplace, l.externalId, l.title, l.pictureUrl, l.permalink, l.price,
         l.availableQuantity, l.status, l.subStatus, l.sku, l.variationSkus,
         l.soldQuantity, l.listingTypeId, l.categoryId, l.freeShipping, l.logisticType,
         l.catalogListing, l.picturesCount, l.dimensions, l.listedAt, l.originalPrice, l.feeBonus, l.promoName, l.flexEnabled ?? false],
      );
    }
  }

  /**
   * Recalcula, para os anúncios da conta, a tarifa e o frete médios por unidade (pedidos pagos de 1 item,
   * já com fretes enriquecidos, últimos 90 dias). Roda ao fim de cada sincronização.
   */
  async refreshListingSalesStats(db: Queryable, accountId: string): Promise<void> {
    await db.query(
      `UPDATE listings l SET sales_fee_avg = x.fee, sales_freight_avg = x.freight, freight_paid_ratio = x.ratio
         FROM (
           SELECT l2.id,
                  sum(o.marketplace_fee) / nullif(sum(o.units), 0) AS fee,
                  sum(o.shipping_cost) / nullif(sum(o.units), 0) AS freight,
                  least(1, sum(o.shipping_cost) FILTER (WHERE o.freight_checked_at IS NOT NULL AND o.shipping_list_cost > 0)
                    / nullif(sum(o.shipping_list_cost) FILTER (WHERE o.freight_checked_at IS NOT NULL AND o.shipping_list_cost > 0), 0)) AS ratio
             FROM listings l2
             LEFT JOIN order_items i ON i.listing_id = l2.external_id
             LEFT JOIN orders o ON o.id = i.order_id AND o.status = 'paid' AND o.finance_enriched_at IS NOT NULL
                                AND o.units = i.quantity AND o.ordered_at > now() - interval '90 days'
            WHERE l2.account_id = $1
            GROUP BY l2.id
         ) x
        WHERE l.id = x.id AND (l.sales_fee_avg IS DISTINCT FROM x.fee OR l.sales_freight_avg IS DISTINCT FROM x.freight
               OR l.freight_paid_ratio IS DISTINCT FROM round(x.ratio, 4))`,
      [accountId],
    );
  }

  /** Anúncios vendidos que ainda não têm foto/dados no catálogo. */
  async listingsMissing(db: Queryable, accountId: string, limit = 400): Promise<string[]> {
    const { rows } = await db.query<{ listing_id: string }>(
      `SELECT DISTINCT i.listing_id FROM order_items i
         JOIN orders o ON o.id = i.order_id
         LEFT JOIN listings l ON l.tenant_id = i.tenant_id AND l.external_id = i.listing_id
        WHERE o.account_id = $1 AND i.listing_id IS NOT NULL AND (l.id IS NULL OR l.picture_url IS NULL)
        LIMIT $2`,
      [accountId, limit],
    );
    return rows.map((r) => r.listing_id);
  }

  /** Anúncios marcados como pausados na base (para revalidar os que voltaram a ficar ativos). */
  async pausedListingIds(db: Queryable, accountId: string): Promise<string[]> {
    const { rows } = await db.query<{ external_id: string }>(
      "SELECT external_id FROM listings WHERE account_id = $1 AND status = 'paused'",
      [accountId],
    );
    return rows.map((r) => r.external_id);
  }

  /** Anúncios que a base considera vivos (ativos, pausados ou em revisão). */
  async liveListingIds(db: Queryable, accountId: string): Promise<string[]> {
    const { rows } = await db.query<{ external_id: string }>(
      "SELECT external_id FROM listings WHERE account_id = $1 AND source = 'marketplace' AND status NOT IN ('closed', 'inactive')",
      [accountId],
    );
    return rows.map((r) => r.external_id);
  }

  /** Anúncios que o ML não devolveu na releitura (excluídos): marcados como encerrados. */
  async closeUnseenListings(db: Queryable, accountId: string, ids: string[], since: Date): Promise<void> {
    await db.query(
      `UPDATE listings SET status = 'closed', updated_at = now()
        WHERE account_id = $1 AND external_id = ANY($2::text[]) AND updated_at < $3 AND status <> 'closed'`,
      [accountId, ids, since],
    );
  }

  async setShippingCost(db: Queryable, orderId: string, cost: number): Promise<void> {
    await db.query('UPDATE orders SET shipping_cost = $2 WHERE id = $1', [orderId, cost]);
  }
}
