import type { FastifyInstance } from 'fastify';
import { financeLinesQuerySchema, financeQuerySchema } from '@nvs/shared';
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
