import type { FastifyInstance } from 'fastify';
import { dashboardQuerySchema } from '@nvs/shared';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { DashboardService } from '../application/dashboard-service.js';

export function salesRoutes(dashboard: DashboardService) {
  return async (app: FastifyInstance) => {
    app.get('/dashboard/summary', { preHandler: app.requirePermission('dashboard:read') }, async (req) => {
      const parsed = dashboardQuerySchema.safeParse(req.query);
      if (!parsed.success) throw new ValidationError('Filtros inválidos', parsed.error.flatten());
      return dashboard.summary(req.user.tenantId, parsed.data);
    });
  };
}
