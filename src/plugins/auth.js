import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { db } from '../db/knex.js';
import { httpError } from '../lib/errors.js';

const hashKey = (key) =>
  createHash('sha256').update(String(key)).digest('hex');

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

  // Verifikasi Bearer JWT atau x-api-key milik user.
  app.decorate('authenticate', async (request) => {
    const apiKey = request.headers['x-api-key'];
    let user;

    // Autentikasi menggunakan API Key.
    if (apiKey && !request.headers.authorization) {
      user = await db('users')
        .where({ api_key_hash: hashKey(apiKey) })
        .first();

      if (!user || !user.is_active) {
        throw httpError(
          401,
          'API key tidak valid atau akun dinonaktifkan',
          'INVALID_API_KEY'
        );
      }
    } else {
      // Autentikasi menggunakan JWT Bearer.
      try {
        await request.jwtVerify();
      } catch {
        throw httpError(
          401,
          'Token tidak valid atau sudah kedaluwarsa',
          'UNAUTHORIZED'
        );
      }

      user = await db('users')
        .where({ id: request.user.sub })
        .first();

      if (
        !user ||
        !user.is_active ||
        Number(request.user.ver ?? 0) !==
          Number(user.token_version ?? 0)
      ) {
        throw httpError(
          401,
          'Token tidak berlaku. Silakan login kembali.',
          'UNAUTHORIZED'
        );
      }

      // Access token harus terikat dengan sesi server-side.
      if (!request.user.sid) {
        throw httpError(
          401,
          'Sesi tidak valid. Silakan login kembali.',
          'UNAUTHORIZED'
        );
      }

      const session = await db('user_sessions')
        .where({
          id: request.user.sid,
          user_id: user.id,
        })
        .whereNull('revoked_at')
        .first();

      if (!session || Number(session.expires_at) <= now()) {
        throw httpError(
          401,
          'Sesi telah berakhir. Silakan login kembali.',
          'UNAUTHORIZED'
        );
      }
    }

    // Muat greenhouse yang menjadi hak akses pengguna.
    const assignments = await db('user_greenhouses')
      .where({ user_id: user.id })
      .pluck('greenhouse_id')
      .catch(() => []);

    request.auth = {
      ...user,
      greenhouse_ids: assignments.length
        ? assignments
        : (user.greenhouse_id ? [user.greenhouse_id] : []),
    };
  });

  // Pemeriksaan hak akses berdasarkan role.
  app.decorate('requireRole', (...roles) => async (request) => {
    if (!roles.includes(request.auth.role)) {
      throw httpError(
        403,
        'Anda tidak memiliki akses untuk aksi ini',
        'FORBIDDEN'
      );
    }
  });

  // Membuat access token dan refresh token sekaligus
  // serta menyimpan sesi ke database.
  app.decorate('issueTokens', async (user, sessionId = newId()) => {
    const payload = {
      sub: user.id,
      role: user.role,
      ver: Number(user.token_version ?? 0),
      sid: sessionId,
    };

    const accessToken = app.jwt.sign(payload);
    const refreshToken = app.jwt.refresh.sign(payload);
    const t = now();

    await db('user_sessions').insert({
      id: sessionId,
      user_id: user.id,
      refresh_token_hash: hashKey(refreshToken),
      expires_at:
        Number(app.jwt.refresh.decode(refreshToken)?.exp || 0) * 1000,
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