import { buildApp } from './app.js';
import { env } from './config/env.js';

const app = await buildApp();

const shutdown = async (signal) => {
  app.log.info(`${signal} diterima, mematikan server...`);
  await app.close();
  process.exit(0);
};
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

try {
  await app.listen({ port: env.port, host: env.host });
  if (env.tb.mock) app.log.warn('THINGSBOARD_MOCK=true: telemetri dan RPC disimulasikan (tidak terhubung ke ThingsBoard)');
  app.log.info(`Dokumentasi API: http://localhost:${env.port}/docs`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
