import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { logActivity } from '../../lib/activity.js';
import { userWithGreenhouse } from '../users/service.js';

const tags = ['Auth'];
const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export default async function authRoutes(app) {
  // Registrasi sementara (belum ada di desain awal). Role selalu "operator"; admin dibuat lewat seed atau diubah admin.
  app.post('/auth/register', {
    config: strictLimit,
    schema: {
      tags,
      summary: 'Registrasi akun baru',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'email', 'password'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          email: { type: 'string', format: 'email', maxLength: 190 },
          password: { type: 'string', minLength: 8, maxLength: 72 },
          phone: { type: 'string', maxLength: 30 },
          job_title: { type: 'string', maxLength: 100 },
          greenhouse: {
            type: 'object',
            additionalProperties: false,
            required: ['name'],
            properties: {
              name: { type: 'string', minLength: 2, maxLength: 150 },
              location: { type: 'string', maxLength: 255 },
              plant_type: { type: 'string', maxLength: 100 },
              area_m2: { type: 'number', minimum: 0 },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const { name, password, phone, job_title, greenhouse } = request.body;
    const email = request.body.email.trim().toLowerCase();
    if (await db('users').where({ email }).first()) {
      throw httpError(409, 'Email sudah terdaftar', 'EMAIL_TAKEN');
    }

    const t = now();
    const userId = newId();
    const password_hash = await bcrypt.hash(password, 10);
    let greenhouseId = null;

    await db.transaction(async (trx) => {
      if (greenhouse) {
        greenhouseId = newId();
        await trx('greenhouses').insert({ id: greenhouseId, ...greenhouse, created_at: t, updated_at: t });
      }
      await trx('users').insert({
        id: userId,
        greenhouse_id: greenhouseId,
        name: name.trim(),
        email,
        phone: phone ?? null,
        job_title: job_title ?? null,
        role: 'operator',
        password_hash,
        is_active: true,
        created_at: t,
        updated_at: t,
      });
    });

    const user = await db('users').where({ id: userId }).first();
    request.auth = user;
    await logActivity(request, { action: 'auth.register', entity: 'user', entity_id: userId, description: `Registrasi akun ${email}` });
    return reply.code(201).send({ ...app.issueTokens(user), user: await userWithGreenhouse(user) });
  });

  app.post('/auth/login', {
    config: strictLimit,
    schema: {
      tags,
      summary: 'Login dengan email dan password',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['email', 'password'],
        properties: {
          email: { type: 'string', format: 'email' },
          password: { type: 'string', minLength: 1, maxLength: 72 },
        },
      },
    },
  }, async (request) => {
    const email = request.body.email.trim().toLowerCase();
    const user = await db('users').where({ email }).first();
    const valid = user && (await bcrypt.compare(request.body.password, user.password_hash));
    if (!valid) throw httpError(401, 'Email atau password salah', 'INVALID_CREDENTIALS');
    if (!user.is_active) throw httpError(403, 'Akun dinonaktifkan. Hubungi admin.', 'ACCOUNT_DISABLED');

    await db('users').where({ id: user.id }).update({ last_login_at: now() });
    request.auth = user;
    await logActivity(request, { action: 'auth.login', entity: 'user', entity_id: user.id, description: `Login ${email}` });
    return { ...app.issueTokens(user), user: await userWithGreenhouse({ ...user, last_login_at: now() }) };
  });

  app.post('/auth/refresh', {
    config: strictLimit,
    schema: {
      tags,
      summary: 'Perbarui access token memakai refresh token',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['refresh_token'],
        properties: { refresh_token: { type: 'string' } },
      },
    },
  }, async (request) => {
    let payload;
    try {
      payload = app.jwt.refresh.verify(request.body.refresh_token);
    } catch {
      throw httpError(401, 'Refresh token tidak valid atau kedaluwarsa', 'INVALID_REFRESH_TOKEN');
    }
    const user = await db('users').where({ id: payload.sub }).first();
    if (!user || !user.is_active) throw httpError(401, 'Akun tidak ditemukan atau nonaktif', 'UNAUTHORIZED');
    return app.issueTokens(user);
  });

  app.post('/auth/change-password', {
    onRequest: [app.authenticate],
    config: strictLimit,
    schema: {
      tags,
      summary: 'Ganti password',
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['current_password', 'new_password'],
        properties: {
          current_password: { type: 'string', maxLength: 72 },
          new_password: { type: 'string', minLength: 8, maxLength: 72 },
        },
      },
    },
  }, async (request) => {
    const ok = await bcrypt.compare(request.body.current_password, request.auth.password_hash);
    if (!ok) throw httpError(400, 'Password saat ini salah', 'WRONG_PASSWORD');
    await db('users').where({ id: request.auth.id }).update({
      password_hash: await bcrypt.hash(request.body.new_password, 10),
      updated_at: now(),
    });
    await logActivity(request, { action: 'auth.change_password', entity: 'user', entity_id: request.auth.id, description: 'Mengganti password' });
    return { message: 'Password berhasil diganti' };
  });
}
