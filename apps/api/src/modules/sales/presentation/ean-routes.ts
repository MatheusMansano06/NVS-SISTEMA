import type { FastifyInstance } from 'fastify';
import { generateEansSchema, listEansSchema, updateEanSchema } from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { buildEanLabelsPdf, type LabelLayout } from '../../wms/index.js';
import type { InternalEanService } from '../application/internal-ean-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

const codeParam = z.object({ code: z.string().regex(/^2\d{12}$/) });

const LAYOUTS: Record<string, LabelLayout> = {
  rolo_1col: { format: 'rolo_1col', widthMm: 50, heightMm: 30 },
  rolo_2col: { format: 'rolo_2col', widthMm: 40, heightMm: 25 },
  a4: { format: 'a4', widthMm: 50, heightMm: 30 },
};

const labelsQuery = z.object({
  codes: z.string().transform((s) => [...new Set(s.split(',').filter((c) => /^2\d{12}$/.test(c)))]).pipe(z.array(z.string()).min(1).max(100)),
  qty: z.coerce.number().int().min(1).max(500).default(1),
  format: z.enum(['rolo_1col', 'rolo_2col', 'a4']).default('rolo_1col'),
});

/** Cadastro de SKUs › Códigos EAN: EAN interno (circulação restrita GS1) por SKU, GTIN oficial e etiquetas. */
export function eanRoutes(service: InternalEanService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('costs:manage') };

    app.get('/skus/eans', read, async (req) => service.list(req.user.tenantId, parse(listEansSchema, req.query)));
    app.post('/skus/eans', write, async (req) => service.generate(req.user.tenantId, req.user.sub, parse(generateEansSchema, req.body)));
    app.patch('/skus/eans/:code', write, async (req) =>
      service.update(req.user.tenantId, parse(codeParam, req.params).code, parse(updateEanSchema, req.body)),
    );
    app.delete('/skus/eans/:code', write, async (req, reply) => {
      await service.remove(req.user.tenantId, parse(codeParam, req.params).code);
      return reply.code(204).send();
    });
    app.get('/skus/eans/labels.pdf', read, async (req, reply) => {
      const q = parse(labelsQuery, req.query);
      const items = await service.byCodes(req.user.tenantId, q.codes);
      const pdf = await buildEanLabelsPdf(items.map((i) => ({ ...i, sku: i.sku ?? '', qty: q.qty })), LAYOUTS[q.format]!);
      return reply.header('content-type', 'application/pdf').header('content-disposition', 'inline; filename="etiquetas-ean.pdf"').send(pdf);
    });
  };
}
