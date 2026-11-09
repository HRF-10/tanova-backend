import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { httpError } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { logActivity } from '../../lib/activity.js';
import { userWithGreenhouse } from '../users/service.js';

const tags = ['Auth'];
const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };

export default async function authRoutes(app) {
  // Registrasi mandiri sengaja tidak disediakan. Akun hanya dibuat oleh admin.
  app.post('/auth/login', {
    config: strictLimit,
    schema: {
      tags, summary: 'Login menggunakan username dan password',
      body: {
        type: 'object', additionalProperties: false, required: ['username', 'password'],
        properties: {
          username: { type: 'string', minLength: 2, maxLength: 80 },
          password: { type: 'string', minLength: 1, maxLength: 72 },
        },
      },
    },
  }, async (request) => {
    const username = request.body.username.trim().toLowerCase();
    const user = await db('users').whereRaw('LOWER(username) = ?', [username]).first();
    const valid = user && (await bcrypt.compare(request.body.password, user.password_hash));
    if (!valid) throw httpError(401, 'Username atau password salah', 'INVALID_CREDENTIALS');
    if (!user.is_active) throw httpError(403, 'Akun dinonaktifkan. Hubungi admin.', 'ACCOUNT_DISABLED');
    const t = now();
    await db('users').where({ id: user.id }).update({ last_login_at: t });
    request.auth = user;
    await logActivity(request, { action: 'auth.login', entity: 'user', entity_id: user.id, description: `Login ${username}` });
    return { ...app.issueTokens(user), user: await userWithGreenhouse({ ...user, last_login_at: t }) };
  });

  app.post('/auth/refresh', {
    config: strictLimit,
    schema: { tags, summary: 'Perbarui access token', body: { type: 'object', additionalProperties: false, required: ['refresh_token'], properties: { refresh_token: { type: 'string' } } } },
  }, async (request) => {
    let payload;
    try { payload = app.jwt.refresh.verify(request.body.refresh_token); }
    catch { throw httpError(401, 'Refresh token tidak valid atau kedaluwarsa', 'INVALID_REFRESH_TOKEN'); }
    const user = await db('users').where({ id: payload.sub }).first();
    if (!user || !user.is_active || Number(payload.ver ?? 0) !== Number(user.token_version ?? 0)) throw httpError(401, 'Refresh token tidak berlaku. Silakan login kembali.', 'UNAUTHORIZED');
    return app.issueTokens(user);
  });

  app.post('/auth/change-password', {
    onRequest: [app.authenticate], config: strictLimit,
    schema: {
      tags, summary: 'Ganti password akun sendiri', security: [{ bearerAuth: [] }],
      body: { type: 'object', additionalProperties: false, required: ['current_password', 'new_password'], properties: {
        current_password: { type: 'string', minLength: 1, maxLength: 72 },
        new_password: { type: 'string', minLength: 8, maxLength: 72 },
      } },
    },
  }, async (request) => {
    const ok = await bcrypt.compare(request.body.current_password, request.auth.password_hash);
    if (!ok) throw httpError(400, 'Password saat ini salah', 'WRONG_PASSWORD');
    await db('users').where({ id: request.auth.id }).update({ password_hash: await bcrypt.hash(request.body.new_password, 12), token_version: Number(request.auth.token_version || 0) + 1, updated_at: now() });
    await logActivity(request, { action: 'auth.change_password', entity: 'user', entity_id: request.auth.id, description: 'Mengganti password' });
    return { message: 'Password berhasil diganti. Silakan login kembali pada perangkat lain.' };
  });
}
