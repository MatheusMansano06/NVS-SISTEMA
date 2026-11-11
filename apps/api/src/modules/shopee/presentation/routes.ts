import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { ShopeeStatusDto } from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import type { ShopeeService } from '../application/shopee-service.js';

class NotConfiguredError extends AppError {
  constructor() {
    super('Integração com a Shopee ainda não configurada neste ambiente', 'NOT_CONFIGURED', 503);
  }
}

/** `service` nulo = variáveis da Shopee ausentes neste ambiente (rotas respondem 503). */
export function shopeeRoutes(service: ShopeeService | null) {
  return async (app: FastifyInstance) => {
    const base = '/integrations/shopee';
    const require = () => {
      if (!service) throw new NotConfiguredError();
      return service;
    };

    app.get(`${base}/connect`, { preHandler: app.authenticate }, async (req) => ({
      url: await require().authorizationUrl(req.user.tenantId, req.user.sub),
    }));

    // a Shopee redireciona o navegador para cá (domínio cadastrado no app); voltamos para Integrações com o resultado.
    // O state vem no caminho (/callback/:state), que é como o link de autorização o envia.
    const callback = async (req: FastifyRequest, reply: FastifyReply) => {
      const q = req.query as { code?: string; state?: string; shop_id?: string; main_account_id?: string; error?: string };
      const state = (req.params as { state?: string }).state ?? q.state;
      if (!service) return reply.redirect('/integracoes?shopee=error&reason=config');
      const result = await service.handleCallback({ ...q, state });
      return reply.redirect(result.ok ? '/integracoes?shopee=connected' : `/integracoes?shopee=error&reason=${result.reason}`);
    };
    app.get(`${base}/callback`, callback);
    app.get(`${base}/callback/:state`, callback);

    app.get(`${base}/status`, { preHandler: app.authenticate }, async (req): Promise<ShopeeStatusDto> => {
      if (!service) return { configured: false, connections: [] };
      return service.status(req.user.tenantId);
    });

    app.post(`${base}/sync`, { preHandler: app.authenticate }, async (req, reply) => {
      const s = require();
      const { connectionId } = (req.body ?? {}) as { connectionId?: string };
      const status = await s.status(req.user.tenantId);
      const target = status.connections.find((c) => c.id === connectionId) ?? status.connections[0];
      if (!target) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Nenhuma loja conectada' } });
      s.startSync(req.user.tenantId, target.id);
      return reply.code(202).send({ ok: true });
    });
  };
}
