import fs from 'node:fs';
import path from 'node:path';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { env } from './config/env.js';
import { db, migrateLatest } from './db/knex.js';
import authPlugin from './plugins/auth.js';
import authRoutes from './modules/auth/routes.js';
import userRoutes from './modules/users/routes.js';
import dashboardRoutes from './modules/dashboard/routes.js';
import deviceRoutes from './modules/devices/routes.js';
import deviceConfigRoutes from './modules/devices/config.js';
import actuatorRoutes from './modules/actuators/routes.js';
import calibrationRoutes from './modules/calibrations/routes.js';
import telemetryRoutes from './modules/telemetry/routes.js';
import alertRoutes from './modules/alerts/routes.js';
import aiRoutes from './modules/ai/routes.js';
import { startAlertEngine } from './services/alertEngine.js';

export async function buildApp({ logger = true, startJobs = true } = {}) {
  const app = Fastify({
    logger: logger && {
      level: env.isProd ? 'info' : 'debug',
      redact: ['req.headers.authorization'],
    },
    trustProxy: true,
    bodyLimit: 1_048_576,
  });

  if (env.db.autoMigrate) await migrateLatest();

  await app.register(helmet, { contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } });
  await app.register(cors, {
    origin: env.corsOrigins.includes('*') ? true : env.corsOrigins,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    exposedHeaders: ['Content-Disposition'],
  });
  await app.register(rateLimit, { max: 300, timeWindow: '1 minute' });
  await app.register(multipart, { limits: { fileSize: env.maxUploadMb * 1024 * 1024, files: 1, fields: 20 } });

  const uploadRoot = path.resolve(env.uploadDir);
  fs.mkdirSync(uploadRoot, { recursive: true });
  await app.register(fastifyStatic, { root: uploadRoot, prefix: '/uploads/' });

  await app.register(swagger, {
    openapi: {
      info: { title: 'Tanova App API', description: 'Backend monitoring hidroponik (Fastify + ThingsBoard). Semua field memakai snake_case.', version: '1.0.0' },
      servers: [{ url: '/api/v1' }],
      components: {
        securitySchemes: {
          bearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: '/docs' });

  await app.register(authPlugin);

  app.setErrorHandler((err, request, reply) => {
    const status = err.validation ? 400 : err.statusCode || 500;
    if (status >= 500) (err.code?.startsWith('TB_') ? request.log.warn(err.message) : request.log.error(err));
    reply.status(status).send({
      statusCode: status,
      code: err.validation ? 'VALIDATION_ERROR' : err.code || (status >= 500 ? 'INTERNAL_ERROR' : 'ERROR'),
      message: status >= 500 && env.isProd && !err.code?.startsWith('TB_') ? 'Terjadi kesalahan pada server' : err.message,
    });
  });
  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({ statusCode: 404, code: 'NOT_FOUND', message: `Rute ${request.method} ${request.url} tidak ditemukan` }));

  app.get('/', { schema: { hide: true } }, async () => ({ name: 'Tanova App API', docs: '/docs', api: '/api/v1' }));
  app.get('/health', { schema: { tags: ['Health'], summary: 'Cek kesehatan layanan' } }, async () => {
    await db.raw('select 1');
    return { status: 'ok', database: 'postgres', thingsboard: env.tb.mock ? 'mock' : 'live', time: new Date().toISOString() };
  });

  await app.register(async (api) => {
    await api.register(authRoutes);
    await api.register(userRoutes);
    await api.register(dashboardRoutes);
    await api.register(deviceRoutes);
    await api.register(deviceConfigRoutes);
    await api.register(actuatorRoutes);
    await api.register(calibrationRoutes);
    await api.register(telemetryRoutes);
    await api.register(alertRoutes);
    await api.register(aiRoutes);
  }, { prefix: '/api/v1' });

  app.addHook('onClose', async () => db.destroy());
  if (startJobs) startAlertEngine(app);
  return app;
}
