import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/**
 * Em produção a API também entrega o frontend (mesma origem: cookies e CORS simples).
 * Assets com hash ficam em cache "imutável"; o index.html nunca é cacheado.
 */
export async function serveWeb(app: FastifyInstance, dir: string | undefined): Promise<void> {
  if (!dir) return;
  const root = resolve(dir);
  if (!existsSync(root)) return;
  await app.register(fastifyStatic, {
    root,
    wildcard: false,
    setHeaders: (res, path) => {
      res.header(
        'cache-control',
        path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  // SPA: qualquer GET que não seja da API cai no index.html
  app.setNotFoundHandler((req, reply) => {
    if (req.method === 'GET' && !req.url.startsWith('/api/')) {
      return reply.header('cache-control', 'no-cache').sendFile('index.html');
    }
    return reply.code(404).send({ error: { code: 'NOT_FOUND', message: 'Rota não encontrada' } });
  });
}
