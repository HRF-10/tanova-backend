import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { db } from '../db/knex.js';
import { httpError } from '../lib/errors.js';

export default fp(async (app) => {
  await app.register(jwt, {
    secret: env.jwt.accessSecret,
    sign: { expiresIn: env.jwt.accessExpires },
  });
  await app.register(jwt, {
    secret: env.jwt.refreshSecret,
    namespace: 'refresh',
    sign: { expiresIn: env.jwt.refreshExpires },
  });

  app.decorateRequest('auth', null);

  // Verifikasi token, lalu muat user terbaru dari database (role & status aktif selalu up to date).
  app.decorate('authenticate', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw httpError(401, 'Token tidak valid atau sudah kedaluwarsa', 'UNAUTHORIZED');
    }
    const user = await db('users').where({ id: request.user.sub }).first();
    if (!user || !user.is_active || Number(request.user.ver ?? 0) !== Number(user.token_version ?? 0)) throw httpError(401, 'Token tidak berlaku. Silakan login kembali.', 'UNAUTHORIZED');
    const assignments = await db('user_greenhouses').where({ user_id: user.id }).pluck('greenhouse_id').catch(() => []);
    request.auth = { ...user, greenhouse_ids: assignments.length ? assignments : (user.greenhouse_id ? [user.greenhouse_id] : []) };
  });

  app.decorate('requireRole', (...roles) => async (request) => {
    if (!roles.includes(request.auth.role)) {
      throw httpError(403, 'Anda tidak memiliki akses untuk aksi ini', 'FORBIDDEN');
    }
  });

  app.decorate('issueTokens', (user) => {
    const payload = { sub: user.id, role: user.role, ver: Number(user.token_version ?? 0) };
    return {
      token_type: 'Bearer',
      access_token: app.jwt.sign(payload),
      refresh_token: app.jwt.refresh.sign(payload),
      expires_in: env.jwt.accessExpires,
    };
  });
});
