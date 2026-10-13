import type { FastifyInstance } from 'fastify';
import type { MlStatusDto } from '@nvs/shared';
import { AppError } from '../../../shared/kernel/errors.js';
import type { MlIntegrationService, MlNotification } from '../application/ml-integration-service.js';

class NotConfiguredError extends AppError {
  constructor() {
    super('Integração com o Mercado Livre ainda não configurada neste ambiente', 'NOT_CONFIGURED', 503);
  }
}

/** `service` nulo = variáveis do ML ausentes neste ambiente (rotas respondem 503). */
export function mercadoLivreRoutes(service: MlIntegrationService | null) {
  return async (app: FastifyInstance) => {
    const base = '/integrations/mercado-livre';
    const require = () => {
      if (!service) throw new NotConfiguredError();
      return service;
    };

    app.get(`${base}/connect`, { preHandler: app.authenticate }, async (req) => ({
      url: await require().authorizationUrl(req.user.tenantId, req.user.sub),
    }));

    // o Mercado Livre redireciona o navegador para cá; voltamos para o app com o resultado
    app.get(`${base}/callback`, async (req, reply) => {
      const q = req.query as { code?: string; state?: string; error?: string };
      if (!service) return reply.redirect('/?ml=error&reason=config');
      const result = await service.handleCallback(q);
      return reply.redirect(result.ok ? '/?ml=connected' : `/?ml=error&reason=${result.reason}`);
    });

    // o ML exige resposta rápida (200 em até 500ms): confirma e processa em segundo plano
    app.post(`${base}/notifications`, { config: { rateLimit: false } }, async (req, reply) => {
      if (service) {
        const n = (req.body ?? {}) as MlNotification;
        setImmediate(() => {
          service.handleNotification(n).catch((err) => req.log.error({ err }, 'Mercado Livre: notificação falhou'));
        });
      }
      return reply.code(200).send({ ok: true });
    });

    app.get(`${base}/status`, { preHandler: app.authenticate }, async (req): Promise<MlStatusDto> => {
      if (!service) return { configured: false, connections: [] };
      return service.status(req.user.tenantId);
    });

    app.post(`${base}/sync`, { preHandler: app.authenticate }, async (req, reply) => {
      const s = require();
      const { connectionId } = (req.body ?? {}) as { connectionId?: string };
      const status = await s.status(req.user.tenantId);
      const target = status.connections.find((c) => c.id === connectionId) ?? status.connections[0];
      if (!target) return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Nenhuma conta conectada' } });
      await s.startSync(req.user.tenantId, target.id);
      return reply.code(202).send({ ok: true });
    });
  };
}
