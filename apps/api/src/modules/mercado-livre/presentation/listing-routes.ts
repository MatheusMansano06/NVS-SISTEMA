import type { FastifyInstance } from 'fastify';
import {
  setFlexSchema,
  duplicateListingSchema,
  enrollPromotionSchema,
  listingTypeSchema,
  listingAttributesSchema,
  listingDescriptionSchema,
  listingDimensionsSchema,
  listingPictureUploadSchema,
  listingPicturesSchema,
  listingWholesaleSchema,
  listListingsSchema,
  setListingPriceSchema,
  setListingStatusSchema,
  setListingStockSchema,
} from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { ListingService } from '../application/listing-service.js';
import type { PromotionService } from '../application/promotion-service.js';
import type { ListingEditorService } from '../application/listing-editor-service.js';
import type { FlexService } from '../application/flex-service.js';
import type { FreightRadarService } from '../application/freight-radar-service.js';

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
export function listingRoutes(
  service: ListingService | null,
  promotions: PromotionService | null = null,
  editor: ListingEditorService | null = null,
  flex: FlexService | null = null,
  radar: FreightRadarService | null = null,
) {
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

    // ---- Editor do anúncio
    const ed = () => {
      if (!editor) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return editor;
    };
    const id = (req: { params: unknown }) => parse(idParam, req.params).id;

    app.get('/listings/:id/editor', read, async (req) => ed().get(req.user.tenantId, id(req)));
    app.put('/listings/:id/description', write, async (req) =>
      ed().setDescription(req.user.tenantId, id(req), parse(listingDescriptionSchema, req.body).text),
    );
    app.put('/listings/:id/attributes', write, async (req) =>
      ed().setAttributes(req.user.tenantId, id(req), parse(listingAttributesSchema, req.body).attributes),
    );
    app.put('/listings/:id/dimensions', write, async (req) =>
      ed().setDimensions(req.user.tenantId, id(req), parse(listingDimensionsSchema, req.body)),
    );
    app.put('/listings/:id/pictures', write, async (req) =>
      ed().setPictures(req.user.tenantId, id(req), parse(listingPicturesSchema, req.body).pictureIds),
    );
    // uma imagem por requisição (base64), para mostrar o progresso de cada uma
    app.post('/listings/:id/pictures/upload', { ...write, bodyLimit: 15_000_000 }, async (req) =>
      ed().uploadPicture(req.user.tenantId, id(req), parse(listingPictureUploadSchema, req.body)),
    );
    app.get('/listings/:id/wholesale', read, async (req) => ed().wholesale(req.user.tenantId, id(req)));
    app.put('/listings/:id/wholesale', write, async (req) =>
      ed().setWholesale(req.user.tenantId, id(req), parse(listingWholesaleSchema, req.body).tiers),
    );

    // ---- Flex
    const fx = () => {
      if (!flex) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return flex;
    };
    app.get('/flex/status', read, async (req) =>
      fx().status(req.user.tenantId, parse(z.object({ refresh: z.enum(['1']).optional() }), req.query).refresh === '1'),
    );
    app.get('/flex/opportunities', read, async (req) => fx().opportunities(req.user.tenantId));

    // ---- Radar de Frete
    const rd = () => {
      if (!radar) throw new ValidationError('Integração com o Mercado Livre ainda não configurada neste ambiente');
      return radar;
    };
    app.get('/freight-radar', read, async (req) => rd().radar(req.user.tenantId));
    // leitura sob demanda: pesada (1 consulta por anúncio), então limitada
    app.post('/freight-radar/refresh', { ...write, config: { rateLimit: { max: 2, timeWindow: '1 hour' } } }, async (req) => ({
      read: await rd().snapshot(req.user.tenantId),
    }));

    app.put('/listings/:id/flex', write, async (req) =>
      fx().setItem(req.user.tenantId, parse(idParam, req.params).id, parse(setFlexSchema, req.body).enabled),
    );

    app.get('/listings', read, async (req) => need().list(req.user.tenantId, parse(listListingsSchema, req.query)));

    app.get('/listings/:id/sales', read, async (req) => {
      const { id } = parse(idParam, req.params);
      const { offset, limit } = parse(pagingSchema, req.query);
      return need().sales(req.user.tenantId, id, offset, limit);
    });

    app.get('/listings/:id/sales/monthly', read, async (req) =>
      need().monthly(req.user.tenantId, parse(idParam, req.params).id),
    );

    app.put('/listings/:id/type', write, async (req) =>
      need().setListingType(req.user.tenantId, parse(idParam, req.params).id, parse(listingTypeSchema, req.body).type),
    );

    app.get('/listings/:id/categories', read, async (req) => {
      const { q } = parse(z.object({ q: z.string().trim().min(2).max(80) }), req.query);
      return need().categories(req.user.tenantId, parse(idParam, req.params).id, q);
    });

    app.post('/listings/:id/duplicate', write, async (req) =>
      need().duplicate(req.user.tenantId, parse(idParam, req.params).id, parse(duplicateListingSchema, req.body ?? {})),
    );

    app.delete('/listings/:id', write, async (req) => need().remove(req.user.tenantId, parse(idParam, req.params).id));

    app.get('/listings/:id/pricing', { ...read, config: { rateLimit: { max: 90, timeWindow: '1 minute' } } }, async (req) => {
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
