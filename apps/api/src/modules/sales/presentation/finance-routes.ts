import type { FastifyInstance } from 'fastify';
import { financeLinesQuerySchema, financeQuerySchema, lowMarginSettingsSchema, taxImpactQuerySchema } from '@nvs/shared';
import type { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import type { FinanceService } from '../application/finance-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Filtros inválidos', r.error.flatten());
  return r.data;
}

/** Análise Financeira: cartões, composição e tabela pedido a pedido (regras NVS-WMS). */
export function financeRoutes(service: FinanceService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    app.get('/finance/summary', read, async (req) => service.summary(req.user.tenantId, parse(financeQuerySchema, req.query)));
    app.get('/finance/lines', read, async (req) =>
      service.lines(req.user.tenantId, parse(financeQuerySchema, req.query), parse(financeLinesQuerySchema, req.query)),
    );
    // alerta de margem baixa do Dashboard (mínimo configurável pela empresa)
    app.get('/finance/low-margin', read, async (req) => service.lowMargin(req.user.tenantId, parse(financeQuerySchema, req.query)));
    app.put('/finance/low-margin/settings', { preHandler: app.requirePermission('costs:manage') }, async (req) =>
      service.setLowMarginPct(req.user.tenantId, parse(lowMarginSettingsSchema, req.body).pct),
    );
    // simulador: quanto cada produto perde (ou ganha) de MC trocando a alíquota de imposto
    app.get('/finance/tax-impact', read, async (req) =>
      service.taxImpact(req.user.tenantId, parse(financeQuerySchema, req.query), parse(taxImpactQuerySchema, req.query)),
    );
    app.get('/finance/export', read, async (req, reply) =>
      reply
        .header('content-type', 'text/csv; charset=utf-8')
        .header('content-disposition', 'attachment; filename="analise-financeira-nvs.csv"')
        .send(
          await service.exportCsv(
            req.user.tenantId,
            parse(financeQuerySchema, req.query),
            parse(financeLinesQuerySchema, req.query),
          ),
        ),
    );
  };
}
