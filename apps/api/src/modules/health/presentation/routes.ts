import type { FastifyInstance } from 'fastify';
import type { Database } from '../../../shared/infrastructure/database.js';

export function healthRoutes(db: Database) {
  return async (app: FastifyInstance) => {
    // liveness: o processo está de pé
    app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));
    // readiness: dependências críticas respondem
    app.get('/ready', async (_req, reply) => {
      try {
        await db.ping();
        return { status: 'ready', database: 'up' };
      } catch {
        return reply.code(503).send({ status: 'unavailable', database: 'down' });
      }
    });
  };
}
