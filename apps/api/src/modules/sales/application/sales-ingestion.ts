import type { Marketplace } from '@nvs/shared';
import type { Queryable } from '../../../shared/infrastructure/database.js';
import { PgSkuRepository } from '../infrastructure/pg-sku-repository.js';

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
  listingType: string | null;
  items: { sku: string; title: string; quantity: number; unitPrice: number; listingId: string | null }[];
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
    for (const o of orders) {
      const { rows } = await db.query<{ id: string }>(
        `INSERT INTO orders (tenant_id, account_id, marketplace, external_id, status, ordered_at,
                             gross_amount, marketplace_fee, units, shipping_ref, buyer_shipping, refund_partial, listing_type)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
         ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE
           SET status = EXCLUDED.status, ordered_at = EXCLUDED.ordered_at,
               gross_amount = EXCLUDED.gross_amount, marketplace_fee = EXCLUDED.marketplace_fee,
               units = EXCLUDED.units, shipping_ref = EXCLUDED.shipping_ref, account_id = EXCLUDED.account_id,
               refund_partial = EXCLUDED.refund_partial, listing_type = EXCLUDED.listing_type,
               -- fretes já calculados pelo envio (rateados em pacote) não são sobrescritos
               buyer_shipping = CASE WHEN orders.finance_enriched_at IS NULL THEN EXCLUDED.buyer_shipping ELSE orders.buyer_shipping END
         RETURNING id`,
        [tenantId, accountId, marketplace, o.externalId, o.status, o.orderedAt, o.gross, o.fee, o.units, o.shippingRef,
         o.buyerShipping, o.refundPartial, o.listingType],
      );
      const orderId = rows[0]!.id;
      orderIds.push(orderId);
      await db.query('DELETE FROM order_items WHERE order_id = $1', [orderId]);
      for (const it of o.items) {
        await db.query(
          `INSERT INTO order_items (tenant_id, order_id, sku, title, quantity, unit_price, listing_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [tenantId, orderId, it.sku, it.title, it.quantity, it.unitPrice, it.listingId],
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
    f: { buyer: number; seller: number; bucket: string; uncertain: boolean },
  ): Promise<string[]> {
    const { rows } = await db.query<{ id: string }>(
      `WITH pack AS (SELECT id FROM orders WHERE shipping_ref = $1),
            n AS (SELECT count(*)::numeric AS c FROM pack)
       UPDATE orders o SET buyer_shipping = round($2 / n.c, 2), shipping_cost = round($3 / n.c, 2),
              logistic_bucket = $4, freight_uncertain = $5, finance_enriched_at = now()
         FROM n WHERE o.id IN (SELECT id FROM pack)
       RETURNING o.id`,
      [shippingRef, f.buyer, f.seller, f.bucket, f.uncertain],
    );
    return rows.map((r) => r.id);
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
                               price, available_quantity, status, sub_status, sku, variation_skus, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now())
         ON CONFLICT (tenant_id, marketplace, external_id) DO UPDATE
           SET title = EXCLUDED.title, picture_url = COALESCE(EXCLUDED.picture_url, listings.picture_url),
               permalink = EXCLUDED.permalink, price = EXCLUDED.price,
               available_quantity = EXCLUDED.available_quantity, status = EXCLUDED.status,
               sub_status = EXCLUDED.sub_status, account_id = EXCLUDED.account_id,
               sku = EXCLUDED.sku, variation_skus = EXCLUDED.variation_skus, updated_at = now()`,
        [tenantId, accountId, marketplace, l.externalId, l.title, l.pictureUrl, l.permalink, l.price,
         l.availableQuantity, l.status, l.subStatus, l.sku, l.variationSkus],
      );
    }
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

  async setShippingCost(db: Queryable, orderId: string, cost: number): Promise<void> {
    await db.query('UPDATE orders SET shipping_cost = $2 WHERE id = $1', [orderId, cost]);
  }
}
