import type { FastifyInstance } from 'fastify';
import { dreEntrySchema, dreQuerySchema } from '@nvs/shared';
import { z } from 'zod';
import { NotFoundError, ValidationError } from '../../../shared/kernel/errors.js';
import type { DreService } from '../application/dre-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}
const idParam = z.object({ id: z.string().uuid() });

/** DRE simplificado: resultado do mês e os gastos (custos e despesas) lançados pela empresa. */
export function dreRoutes(service: DreService) {
  return async (app: FastifyInstance) => {
    const read = { preHandler: app.requirePermission('dashboard:read') };
    const write = { preHandler: app.requirePermission('costs:manage') };

    app.get('/dre', read, async (req) => service.dre(req.user.tenantId, parse(dreQuerySchema, req.query)));
    app.get('/dre/entries', read, async (req) => service.list(req.user.tenantId));
    app.post('/dre/entries', write, async (req, reply) =>
      reply.code(201).send(await service.create(req.user.tenantId, req.user.sub, parse(dreEntrySchema, req.body))),
    );
    app.put('/dre/entries/:id', write, async (req) => {
      const { id } = parse(idParam, req.params);
      const saved = await service.update(req.user.tenantId, id, parse(dreEntrySchema, req.body));
      if (!saved) throw new NotFoundError('Lançamento não encontrado');
      return saved;
    });
    app.delete('/dre/entries/:id', write, async (req, reply) => {
      const { id } = parse(idParam, req.params);
      if (!(await service.remove(req.user.tenantId, id))) throw new NotFoundError('Lançamento não encontrado');
      return reply.code(204).send();
    });
  };
}
