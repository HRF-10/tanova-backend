import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { env } from '../config/env.js';
import { createHash } from 'node:crypto';
import { newId } from '../lib/ids.js';
import { now } from '../lib/time.js';
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
    // Access token terikat ke sesi server-side agar logout dapat langsung mencabutnya.
    if (!request.user.sid) throw httpError(401, 'Sesi tidak valid. Silakan login kembali.', 'UNAUTHORIZED');
    const session = await db('user_sessions').where({ id: request.user.sid, user_id: user.id }).whereNull('revoked_at').first().catch(() => null);
    if (!session || Number(session.expires_at) <= now()) throw httpError(401, 'Sesi telah berakhir. Silakan login kembali.', 'UNAUTHORIZED');
    const assignments = await db('user_greenhouses').where({ user_id: user.id }).pluck('greenhouse_id').catch(() => []);
    request.auth = { ...user, greenhouse_ids: assignments.length ? assignments : (user.greenhouse_id ? [user.greenhouse_id] : []) };
  });

  app.decorate('requireRole', (...roles) => async (request) => {
    if (!roles.includes(request.auth.role)) {
      throw httpError(403, 'Anda tidak memiliki akses untuk aksi ini', 'FORBIDDEN');
    }
  });

  app.decorate('issueTokens', async (user, sessionId = newId()) => {
    const payload = { sub: user.id, role: user.role, ver: Number(user.token_version ?? 0), sid: sessionId };
    const accessToken = app.jwt.sign(payload);
    const refreshToken = app.jwt.refresh.sign(payload);
    const t = now();
    await db('user_sessions').insert({
      id: sessionId,
      user_id: user.id,
      refresh_token_hash: createHash('sha256').update(refreshToken).digest('hex'),
      expires_at: Number(app.jwt.refresh.decode(refreshToken)?.exp || 0) * 1000,
      created_at: t,
      last_used_at: t,
      revoked_at: null,
    });
    return {
      token_type: 'Bearer',
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_in: env.jwt.accessExpires,
    };
  });

});
