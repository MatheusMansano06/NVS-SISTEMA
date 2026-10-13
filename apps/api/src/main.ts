import { loadEnv } from './config/env.js';
import { buildApp } from './app.js';

const env = loadEnv();
const app = await buildApp({ env });
const stopScheduler = app.ml?.startScheduler();
const stopRetention = app.retention.startScheduler();
const stopRadar = app.radar?.startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    app.log.info({ signal }, 'encerrando');
    stopScheduler?.();
    stopRetention();
    stopRadar?.();
    app.close().then(() => process.exit(0));
  });
}

await app.listen({ port: env.PORT, host: env.HOST });
