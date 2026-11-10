import type { FastifyInstance } from 'fastify';
import type { TiktokStatusDto } from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import type { TiktokShopService } from '../application/tiktok-shop-service.js';

class NotConfiguredError extends AppError {
  constructor() {
    super('Integração com o TikTok Shop ainda não configurada neste ambiente', 'NOT_CONFIGURED', 503);
  }
}

/** `service` nulo = variáveis do TikTok Shop ausentes neste ambiente (rotas respondem 503). */
export function tiktokShopRoutes(service: TiktokShopService | null) {
  return async (app: FastifyInstance) => {
    const base = '/integrations/tiktok-shop';
    const require = () => {
      if (!service) throw new NotConfiguredError();
      return service;
    };

    app.get(`${base}/connect`, { preHandler: app.authenticate }, async (req) => ({
      url: await require().authorizationUrl(req.user.tenantId, req.user.sub),
    }));

    // o TikTok Shop redireciona o navegador para cá (URL cadastrada no app); voltamos para Integrações com o resultado
    app.get(`${base}/callback`, async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };
      if (!service) return reply.redirect('/integracoes?tiktok=error&reason=config');
      const result = await service.handleCallback(q);
      return reply.redirect(result.ok ? '/integracoes?tiktok=connected' : `/integracoes?tiktok=error&reason=${result.reason}`);
    });

    app.get(`${base}/status`, { preHandler: app.authenticate }, async (req): Promise<TiktokStatusDto> => {
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
