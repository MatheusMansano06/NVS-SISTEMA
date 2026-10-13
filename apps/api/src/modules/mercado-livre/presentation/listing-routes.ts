import type { FastifyInstance } from 'fastify';
import {
  enrollPromotionSchema,
  listListingsSchema,
  setListingPriceSchema,
  setListingStatusSchema,
  setListingStockSchema,
} from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { ListingService } from '../application/listing-service.js';
import type { PromotionService } from '../application/promotion-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const idParam = z.object({ id: z.string().regex(/^[A-Z]{3}\d+$/, 'Código de anúncio inválido') });
const pagingSchema = z.object({
  offset: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/** Aba Anúncios (Mercado Livre): lista, vendas, simulação de preço e ações. */
export function listingRoutes(service: ListingService | null, promotions: PromotionService | null = null) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('listings:manage') };
    const need = () => {
      if (!service) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return service;
    };

    const promos = () => {
      if (!promotions) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return promotions;
    };
    const promoParams = z.object({
      connectionId: z.string().uuid(),
      promotionId: z.string().min(1).max(80).regex(/^[\w-]+$/),
    });
    const fresh = z.object({ refresh: z.enum(['1']).optional() });

    // ---- Central de Promoção
    app.get('/listings/promotions', read, async (req) =>
      promos().list(req.user.tenantId, parse(fresh, req.query).refresh === '1'),
    );

    app.get('/listings/promotions/:connectionId/:promotionId/candidates', read, async (req) => {
      const { connectionId, promotionId } = parse(promoParams, req.params);
      const { type, refresh } = parse(fresh.extend({ type: z.string().min(1).max(40) }), req.query);
      return promos().candidates(req.user.tenantId, connectionId, promotionId, type, refresh === '1');
    });

    app.post('/listings/promotions/:connectionId/:promotionId/items/:id', write, async (req) => {
      const { connectionId, promotionId } = parse(promoParams, req.params);
      const { id } = parse(idParam, req.params);
      return promos().enroll(req.user.tenantId, connectionId, promotionId, id, parse(enrollPromotionSchema, req.body));
    });

    app.get('/listings', read, async (req) => need().list(req.user.tenantId, parse(listListingsSchema, req.query)));

    app.get('/listings/:id/sales', read, async (req) => {
      const { id } = parse(idParam, req.params);
      const { offset, limit } = parse(pagingSchema, req.query);
      return need().sales(req.user.tenantId, id, offset, limit);
    });

    app.get('/listings/:id/pricing', read, async (req) => {
      const { id } = parse(idParam, req.params);
      const { price, refresh } = parse(z.object({ price: z.coerce.number().positive().optional(), refresh: z.enum(['1']).optional() }), req.query);
      return need().pricing(req.user.tenantId, id, price, refresh === '1');
    });

    app.put('/listings/:id/price', write, async (req) => {
      const { id } = parse(idParam, req.params);
      return need().setPrice(req.user.tenantId, id, parse(setListingPriceSchema, req.body).price);
    });

    app.put('/listings/:id/stock', write, async (req) => {
      const { id } = parse(idParam, req.params);
      return need().setStock(req.user.tenantId, id, parse(setListingStockSchema, req.body).quantity);
    });

    app.put('/listings/:id/status', write, async (req) => {
      const { id } = parse(idParam, req.params);
      return need().setStatus(req.user.tenantId, id, parse(setListingStatusSchema, req.body).status);
    });
  };
}
