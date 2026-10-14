import type { FastifyInstance } from 'fastify';
import { importSkusSchema, listSkusSchema, saveSkuCostSchema, taxRateSchema } from '@nvs/shared';
import type { z } from 'zod';
import { NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import type { SkuCostService } from '../application/sku-cost-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

/** Cadastro de SKUs: custo unitário e imposto % que alimentam lucro, margem e a análise financeira. */
export function skuRoutes(service: SkuCostService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('costs:manage') };

    app.get('/skus', read, async (req) => service.list(req.user.tenantId, parse(listSkusSchema, req.query)));

    app.put('/skus', write, async (req) =>
      service.save(req.user.tenantId, req.user.sub, parse(saveSkuCostSchema, req.body)),
    );

    app.delete('/skus', write, async (req, reply) => {
      const { sku } = (req.body ?? {}) as { sku?: string };
      if (!sku) throw new ValidationError('Informe o SKU');
      if (!(await service.remove(req.user.tenantId, req.user.sub, sku))) throw new NotFoundError('SKU sem custo cadastrado');
      return reply.code(204).send();
    });

    app.post('/skus/import', { ...write, bodyLimit: 3_000_000 }, async (req) => {
      const { csv, dryRun, ignoreUnknown } = parse(importSkusSchema, req.body);
      return service.importCsv(req.user.tenantId, req.user.sub, csv, dryRun, undefined, ignoreUnknown);
    });

    // alíquota única de imposto da empresa (vale para todas as vendas)
    app.get('/settings/tax-rate', read, async (req) => service.taxRate(req.user.tenantId));
    app.put('/settings/tax-rate', write, async (req) =>
      service.setTaxRate(req.user.tenantId, req.user.sub, parse(taxRateSchema, req.body).ratePct),
    );

    app.get('/skus/export', read, async (req, reply) =>
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="cadastro-skus-nvs.csv"')
        .send(await service.exportCsv(req.user.tenantId)),
    );
  };
}
