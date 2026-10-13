import type { FastifyInstance } from 'fastify';
import { difalSettingsSchema, salesOrdersQuerySchema, salesQuerySchema } from '@nvs/shared';
import type { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { SalesAnalyticsService } from '../application/sales-analytics-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}

/** Aba Vendas: visão geral, pedidos e configuração do DIFAL (por empresa). */
export function salesAnalyticsRoutes(service: SalesAnalyticsService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('costs:manage') };

    app.get('/sales/overview', read, async (req) => service.overview(req.user.tenantId, parse(salesQuerySchema, req.query)));
    app.get('/sales/orders', read, async (req) => service.orders(req.user.tenantId, parse(salesOrdersQuerySchema, req.query)));
    app.get('/settings/difal', read, async (req) => service.settings(req.user.tenantId));
    app.put('/settings/difal', write, async (req) =>
      service.saveSettings(req.user.tenantId, req.user.sub, parse(difalSettingsSchema, req.body)),
    );
  };
}
