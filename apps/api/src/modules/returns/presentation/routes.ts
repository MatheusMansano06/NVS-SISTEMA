import type { FastifyInstance, FastifyRequest } from 'fastify';
import {
  returnCheckSchema,
  returnDisputeSchema,
  returnFindSchema,
  returnListQuerySchema,
  returnReplySchema,
  returnTicketSchema,
} from '@nvs/shared';
import { z } from 'zod';
import { ValidationError } from '../../../shared/kernel/errors.js';
import { readPerson } from '../../operation/index.js';
import type { ReturnActor, ReturnsService } from '../application/returns-service.js';

function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.infer<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw new ValidationError('Revise os dados informados', r.error.flatten());
  return r.data;
}
const id = z.object({ id: z.string().uuid() });

/**
 * Central de Devoluções. Sessão da empresa + pessoa da equipe (nome + PIN): painel e B.I na Análise; bipe e
 * conferência na Operação (a Análise também pode agir). Toda ação registra quem fez.
 */
export function returnsRoutes(service: ReturnsService) {
  return async (app: FastifyInstance) => {
    const auth = { preHandler: app.authenticate };
    const actor = (req: FastifyRequest): ReturnActor => ({ tenantId: req.user.tenantId, operatorId: readPerson(app, req).sub });
    const tenant = (req: FastifyRequest) => actor(req).tenantId;
    const rid = (req: FastifyRequest) => parse(id, req.params).id;

    app.get('/returns/summary', auth, async (req) => service.summary(tenant(req)));
    app.get('/returns', auth, async (req) => service.list(tenant(req), parse(returnListQuerySchema, req.query)));
    app.get('/returns/bi', auth, async (req) => service.bi(tenant(req), parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query).days));
    app.post('/returns/sync', { preHandler: app.authenticate, config: { rateLimit: { max: 4, timeWindow: '1 minute' } } }, async (req, reply) =>
      reply.code(202).send(service.startSync(tenant(req))),
    );
    app.post('/returns/find', { preHandler: app.authenticate, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
      const b = parse(returnFindSchema, req.body);
      return { matches: await service.find(tenant(req), b.code, b.label) };
    });
    app.get('/returns/:id', auth, async (req) => service.detail(tenant(req), rid(req)));
    app.post('/returns/:id/check', auth, async (req) => service.check(actor(req), rid(req), parse(returnCheckSchema, req.body)));
    app.post('/returns/:id/stock-done', auth, async (req) => service.stockDone(actor(req), rid(req)));
    app.post('/returns/:id/manual-ticket', auth, async (req) => service.manualTicket(actor(req), rid(req), { open: false }));
    app.post('/returns/:id/ticket-opened', auth, async (req) => {
      const b = parse(returnTicketSchema, req.body ?? {});
      return service.manualTicket(actor(req), rid(req), { open: true, protocol: b.protocol, note: b.note });
    });
    app.get('/returns/:id/dispute-reasons', auth, async (req) => service.disputeReasons(tenant(req), rid(req)));
    app.post('/returns/:id/dispute', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      service.dispute(actor(req), rid(req), parse(returnDisputeSchema, req.body)),
    );
    app.post('/returns/:id/accept', { preHandler: app.authenticate, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) =>
      service.accept(actor(req), rid(req)),
    );

    // fotos de evidência (base64 no corpo: até ~8 MB por foto)
    app.post('/returns/:id/evidence', { preHandler: app.authenticate, bodyLimit: 12_000_000 }, async (req) => {
      const b = parse(z.object({ mime: z.string().max(40), dataBase64: z.string().min(10).max(11_500_000) }), req.body);
      return service.addEvidence(actor(req), rid(req), b.mime, Buffer.from(b.dataBase64, 'base64'));
    });
    app.get('/returns/evidence/:id', auth, async (req, reply) => {
      const f = await service.evidenceFile(tenant(req), rid(req));
      return reply.header('content-type', f.mime).header('cache-control', 'private, max-age=3600').send(f.bytes);
    });
    app.delete('/returns/evidence/:id', auth, async (req, reply) => {
      await service.deleteEvidence(tenant(req), rid(req));
      return reply.code(204).send();
    });

    // respostas prontas
    app.get('/returns/replies', auth, async (req) => service.replies(tenant(req)));
    app.post('/returns/replies', auth, async (req, reply) => reply.code(201).send(await service.addReply(tenant(req), parse(returnReplySchema, req.body).text)));
    app.delete('/returns/replies/:id', auth, async (req, reply) => {
      await service.deleteReply(tenant(req), rid(req));
      return reply.code(204).send();
    });
  };
}
