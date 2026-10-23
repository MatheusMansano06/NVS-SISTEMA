import type { FastifyInstance } from 'fastify';
import { importQuoteSchema, quotePdfSchema, savePricingStudySchema, savePricingSupplierSchema } from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { PricingStudyService } from '../application/pricing-study-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const idParam = z.object({ id: z.string().uuid() });

/** Precificador › Viabilidade: não depende do Mercado Livre conectado (usa as tabelas fixas). */
export function pricingStudyRoutes(service: PricingStudyService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('listings:manage') };

    app.get('/pricing/studies', read, async (req) => service.list(req.user.tenantId));
    app.post('/pricing/studies', write, async (req) =>
      service.create(req.user.tenantId, req.user.sub, parse(savePricingStudySchema, req.body)),
    );
    app.put('/pricing/studies/:id', write, async (req) =>
      service.update(req.user.tenantId, parse(idParam, req.params).id, parse(savePricingStudySchema, req.body)),
    );
    app.delete('/pricing/studies/:id', write, async (req, reply) => {
      await service.remove(req.user.tenantId, parse(idParam, req.params).id);
      return reply.code(204).send();
    });

    // fornecedores (pastas) e importação da cotação
    app.get('/pricing/suppliers', read, async (req) => service.suppliers(req.user.tenantId));
    app.post('/pricing/suppliers', write, async (req) => service.createSupplier(req.user.tenantId, parse(savePricingSupplierSchema, req.body)));
    app.put('/pricing/suppliers/:id', write, async (req) =>
      service.updateSupplier(req.user.tenantId, parse(idParam, req.params).id, parse(savePricingSupplierSchema, req.body)),
    );
    app.delete('/pricing/suppliers/:id', write, async (req, reply) => {
      await service.removeSupplier(req.user.tenantId, parse(idParam, req.params).id);
      return reply.code(204).send();
    });
    app.post('/pricing/studies/import', { ...write, bodyLimit: 1_000_000 }, async (req) =>
      service.importQuote(req.user.tenantId, req.user.sub, parse(importQuoteSchema, req.body)),
    );
    app.post('/pricing/quote-pdf', { ...write, bodyLimit: 15_000_000, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => ({
      rows: await service.quotePdfRows(parse(quotePdfSchema, req.body).pdfBase64),
    }));
  };
}
