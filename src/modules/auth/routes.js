import bcrypt from 'bcryptjs';
import { createHash, randomBytes } from 'node:crypto';
import { db } from '../../db/knex.js';
import { httpError } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { logActivity } from '../../lib/activity.js';
import { newId } from '../../lib/ids.js';
import { sendEmail } from '../../services/email.js';
import { env } from '../../config/env.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { userWithGreenhouse } from '../users/service.js';

const tags = ['Auth'];
const strictLimit = { rateLimit: { max: 10, timeWindow: '1 minute' } };
const escapeHtml = (value) => String(value).replace(/[&<>\"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' })[char]);

export default async function authRoutes(app) {
  // Registrasi mandiri sengaja tidak disediakan. Akun hanya dibuat oleh admin.
  app.post('/auth/forgot-password', {
    config: strictLimit,
    schema: {
      tags, summary: 'Minta tautan reset password melalui email',
      body: { type: 'object', additionalProperties: false, required: ['email'], properties: {
        email: { type: 'string', format: 'email', maxLength: 190 },
      } },
    },
  }, async (request) => {
    const email = request.body.email.trim().toLowerCase();
    const user = await db('users').whereRaw('LOWER(email) = ?', [email]).where({ is_active: true }).first();
    const response = { message: 'Jika email terdaftar, tautan reset password akan dikirim.' };

    if (user) {
      const rawToken = randomBytes(32).toString('hex');
      const t = now();
      await db.transaction(async (trx) => {
        // Hanya satu token reset aktif per akun.
        await trx('password_reset_tokens').where({ user_id: user.id }).whereNull('used_at').update({ used_at: t });
        await trx('password_reset_tokens').insert({
          id: newId(), user_id: user.id,
          token_hash: createHash('sha256').update(rawToken).digest('hex'),
          expires_at: t + 30 * 60 * 1000, created_at: t,
        });
      });

      const resetUrl = `${env.email.frontendUrl}/reset-password?token=${rawToken}`;
      try {
        const delivery = await sendEmail({
          to: user.email,
          subject: 'Reset password akun Tanova',
          text: `Halo ${user.name},\n\nGunakan tautan berikut untuk membuat password baru (berlaku 30 menit):\n${resetUrl}\n\nJika Anda tidak meminta reset password, abaikan email ini.`,
          html: `<p>Halo ${escapeHtml(user.name)},</p><p>Kami menerima permintaan reset password akun Tanova Anda.</p><p><a href="${resetUrl}">Buat password baru</a></p><p>Tautan berlaku selama 30 menit. Jika Anda tidak meminta reset password, abaikan email ini.</p>`,
        });
        // Token hanya dikembalikan untuk pengujian lokal, tidak pernah di production.
        if (!delivery.sent && !env.isProd) response.debug_reset_token = rawToken;
      } catch (err) {
        request.log.error({ err }, 'gagal mengirim email reset password');
        if (!env.isProd) response.debug_reset_token = rawToken;
      }
    }
    return response;
  });

  app.post('/auth/reset-password', {
    config: strictLimit,
    schema: {
      tags, summary: 'Atur password baru menggunakan token email',
      body: { type: 'object', additionalProperties: false, required: ['token', 'new_password'], properties: {
        token: { type: 'string', minLength: 32, maxLength: 128 },
        new_password: { type: 'string', minLength: 8, maxLength: 72 },
      } },
    },
  }, async (request) => {
    const tokenHash = createHash('sha256').update(request.body.token).digest('hex');
    const t = now();
    const result = await db.transaction(async (trx) => {
      const token = await trx('password_reset_tokens').where({ token_hash: tokenHash }).forUpdate().first();
      if (!token || token.used_at || Number(token.expires_at) <= t) return null;
      const user = await trx('users').where({ id: token.user_id }).forUpdate().first();
      if (!user || !user.is_active) return null;
      await trx('users').where({ id: user.id }).update({
        password_hash: await bcrypt.hash(request.body.new_password, 12),
        token_version: Number(user.token_version || 0) + 1,
        updated_at: t,
      });
      await trx('password_reset_tokens').where({ id: token.id }).update({ used_at: t });
      // Batalkan token reset lain milik akun yang sama.
      await trx('password_reset_tokens').where({ user_id: user.id }).whereNull('used_at').update({ used_at: t });
      return user;
    });
    if (!result) throw httpError(400, 'Token reset tidak valid, sudah digunakan, atau kedaluwarsa', 'INVALID_RESET_TOKEN');
    await logActivity(request, { action: 'auth.reset_password', entity: 'user', entity_id: result.id, description: 'Password direset melalui email' });
    return { message: 'Password berhasil direset. Silakan login menggunakan password baru.' };
  });
  app.post('/auth/login', {
    config: strictLimit,
    schema: {
      tags, summary: 'Login menggunakan username dan password',
      description: 'Mengembalikan access_token, refresh_token, api_key (header x-api-key untuk akses semua resource milik user), dan profil user.',
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
    let apiKey;
    if (user.api_key_enc) {
      try { apiKey = decrypt(user.api_key_enc); } catch { /* regenerasi jika kunci enkripsi berubah */ }
    }
    const userPatch = { last_login_at: t };
    if (!apiKey) {
      apiKey = `tnv_${randomBytes(24).toString('hex')}`;
      userPatch.api_key_hash = createHash('sha256').update(apiKey).digest('hex');
      userPatch.api_key_enc = encrypt(apiKey);
    }
    await db('users').where({ id: user.id }).update(userPatch);
    request.auth = user;
    await logActivity(request, { action: 'auth.login', entity: 'user', entity_id: user.id, description: `Login ${username}` });
    return { ...app.issueTokens(user), api_key: apiKey, user: await userWithGreenhouse({ ...user, last_login_at: t }) };
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
