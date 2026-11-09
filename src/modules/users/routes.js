import bcrypt from 'bcryptjs';
import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { pageMeta, pageParams } from '../../lib/pagination.js';
import { contains } from '../../lib/like.js';
import { logActivity } from '../../lib/activity.js';
import { userWithGreenhouse } from './service.js';

const tags = ['Users & Profile'];
const security = [{ bearerAuth: [] }];
const adminOnly = (app) => [app.authenticate, app.requireRole('admin')];
const usernameSchema = { type: 'string', minLength: 3, maxLength: 80, pattern: '^[a-zA-Z0-9_.-]+$' };

export default async function userRoutes(app) {
  const auth = [app.authenticate];
  const admin = adminOnly(app);

  app.get('/users/me', { onRequest: auth, schema: { tags, security, summary: 'Profil akun dan greenhouse yang ditetapkan' } }, async (request) => userWithGreenhouse(request.auth));

  // Identitas akun dikelola admin; user hanya dapat mengganti password sendiri.
  app.get('/users', {
    onRequest: admin,
    schema: { tags, security, summary: 'Daftar akun (admin)', querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, q: { type: 'string' } } } },
  }, async (request) => {
    const { page, limit, offset } = pageParams(request.query);
    const base = db('users');
    if (request.query.q) base.where((b) => b.where('name', 'ilike', contains(request.query.q)).orWhere('username', 'ilike', contains(request.query.q)).orWhere('email', 'ilike', contains(request.query.q)));
    const [{ total }] = await base.clone().count({ total: '*' });
    const rows = await base.orderBy('created_at', 'desc').limit(limit).offset(offset);
    const data = await Promise.all(rows.map(userWithGreenhouse));
    return { data, meta: pageMeta(page, limit, Number(total)) };
  });

  app.get('/users/:id', { onRequest: admin, schema: { tags, security, summary: 'Detail akun (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } }, async (request) => {
    const row = await db('users').where({ id: request.params.id }).first();
    if (!row) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
    return userWithGreenhouse(row);
  });

  app.post('/users', {
    onRequest: admin,
    schema: { tags, security, summary: 'Buat akun user (admin)', body: { type: 'object', additionalProperties: false, required: ['name', 'username', 'email', 'password'], properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 }, username: usernameSchema,
      email: { type: 'string', format: 'email', maxLength: 190 }, password: { type: 'string', minLength: 8, maxLength: 72 },
      phone: { type: ['string', 'null'], maxLength: 30 }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'], default: 'operator' },
      greenhouse_ids: { type: 'array', uniqueItems: true, items: { type: 'string' } },
    } } },
  }, async (request, reply) => {
    const b = request.body; const username = b.username.trim().toLowerCase(); const email = b.email.trim().toLowerCase();
    if (await db('users').whereRaw('LOWER(username) = ?', [username]).first()) throw httpError(409, 'Username sudah digunakan', 'USERNAME_TAKEN');
    if (await db('users').where({ email }).first()) throw httpError(409, 'Email sudah digunakan', 'EMAIL_TAKEN');
    const ids = b.greenhouse_ids || [];
    const t = now(); const id = newId();
    await db.transaction(async (trx) => {
      if (ids.length) {
        const found = await trx('greenhouses').whereIn('id', ids).select('id');
        if (found.length !== ids.length) throw httpError(404, 'Salah satu greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
        const owned = await trx('user_greenhouses').whereIn('greenhouse_id', ids).first();
        if (owned) throw httpError(409, 'Greenhouse sudah dimiliki akun lain', 'GREENHOUSE_ALREADY_ASSIGNED');
      }
      await trx('users').insert({ id, name: b.name.trim(), username, email, phone: b.phone ?? null, role: b.role || 'operator', password_hash: await bcrypt.hash(b.password, 12), is_active: true, greenhouse_id: ids[0] || null, created_at: t, updated_at: t });
      if (ids.length) await trx('user_greenhouses').insert(ids.map((greenhouse_id) => ({ user_id: id, greenhouse_id, created_at: t })));
    });
    await logActivity(request, { action: 'user.create', entity: 'user', entity_id: id, description: `Admin membuat akun ${username}`, meta: { role: b.role || 'operator', greenhouse_ids: ids } });
    return reply.code(201).send(await userWithGreenhouse(await db('users').where({ id }).first()));
  });

  app.patch('/users/:id', {
    onRequest: admin,
    schema: { tags, security, summary: 'Ubah identitas, role, atau status akun (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: {
      name: { type: 'string', minLength: 2, maxLength: 100 }, username: usernameSchema, email: { type: 'string', format: 'email', maxLength: 190 }, phone: { type: ['string', 'null'], maxLength: 30 }, role: { type: 'string', enum: ['admin', 'operator', 'viewer'] }, is_active: { type: 'boolean' },
    } } },
  }, async (request) => {
    const target = await db('users').where({ id: request.params.id }).first();
    if (!target) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
    const patch = { ...request.body, updated_at: now() };
    if (target.id === request.auth.id && (patch.role && patch.role !== 'admin' || patch.is_active === false)) throw httpError(400, 'Admin tidak dapat menurunkan role atau menonaktifkan akunnya sendiri', 'SELF_MODIFY');
    if (patch.username) {
      patch.username = patch.username.trim().toLowerCase();
      if (await db('users').whereRaw('LOWER(username) = ?', [patch.username]).whereNot({ id: target.id }).first()) throw httpError(409, 'Username sudah digunakan', 'USERNAME_TAKEN');
    }
    if (patch.email) {
      patch.email = patch.email.trim().toLowerCase();
      if (await db('users').where({ email: patch.email }).whereNot({ id: target.id }).first()) throw httpError(409, 'Email sudah digunakan', 'EMAIL_TAKEN');
    }
    if (patch.is_active !== undefined && patch.is_active !== target.is_active) patch.token_version = Number(target.token_version || 0) + 1;
    await db('users').where({ id: target.id }).update(patch);
    await logActivity(request, { action: 'user.admin_update', entity: 'user', entity_id: target.id, description: `Admin memperbarui akun ${target.username}`, meta: { fields: Object.keys(request.body) } });
    return userWithGreenhouse(await db('users').where({ id: target.id }).first());
  });

  app.put('/users/:id/password', {
    onRequest: admin,
    schema: { tags, security, summary: 'Reset password user (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', additionalProperties: false, required: ['password'], properties: { password: { type: 'string', minLength: 8, maxLength: 72 } } } },
  }, async (request) => {
    const target = await db('users').where({ id: request.params.id }).first();
    if (!target) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
    await db('users').where({ id: target.id }).update({ password_hash: await bcrypt.hash(request.body.password, 12), token_version: Number(target.token_version || 0) + 1, updated_at: now() });
    await logActivity(request, { action: 'user.reset_password', entity: 'user', entity_id: target.id, description: `Admin mereset password akun ${target.username}` });
    return { message: 'Password berhasil direset. Sampaikan password awal melalui kanal yang aman.' };
  });

  app.put('/users/:id/greenhouses', {
    onRequest: admin,
    schema: { tags, security, summary: 'Atur greenhouse yang dimiliki user (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } }, body: { type: 'object', additionalProperties: false, required: ['greenhouse_ids'], properties: { greenhouse_ids: { type: 'array', uniqueItems: true, items: { type: 'string' } } } } },
  }, async (request) => {
    const userId = request.params.id; const ids = request.body.greenhouse_ids; const t = now();
    await db.transaction(async (trx) => {
      const user = await trx('users').where({ id: userId }).first();
      if (!user) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
      const found = ids.length ? await trx('greenhouses').whereIn('id', ids).select('id') : [];
      if (found.length !== ids.length) throw httpError(404, 'Salah satu greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
      const conflicts = ids.length ? await trx('user_greenhouses').whereIn('greenhouse_id', ids).whereNot({ user_id: userId }).select('user_id', 'greenhouse_id') : [];
      const previousOwners = [...new Set(conflicts.map((x) => x.user_id))];
      // Admin dapat memindahkan kepemilikan secara atomik: lepaskan dari pemilik lama,
      // lalu tetapkan ke akun tujuan dalam transaksi yang sama.
      for (const previousOwnerId of previousOwners) {
        const movedIds = conflicts.filter((x) => x.user_id === previousOwnerId).map((x) => x.greenhouse_id);
        await trx('user_greenhouses').where({ user_id: previousOwnerId }).whereIn('greenhouse_id', movedIds).delete();
        const previous = await trx('users').where({ id: previousOwnerId }).first();
        if (previous && movedIds.includes(previous.greenhouse_id)) {
          const remaining = await trx('user_greenhouses').where({ user_id: previousOwnerId }).first();
          await trx('users').where({ id: previousOwnerId }).update({ greenhouse_id: remaining?.greenhouse_id || null, updated_at: t });
        }
      }
      await trx('user_greenhouses').where({ user_id: userId }).delete();
      if (ids.length) await trx('user_greenhouses').insert(ids.map((greenhouse_id) => ({ user_id: userId, greenhouse_id, created_at: t })));
      await trx('users').where({ id: userId }).update({ greenhouse_id: ids[0] || null, updated_at: t });
    });
    await logActivity(request, { action: 'user.greenhouses_update', entity: 'user', entity_id: userId, description: 'Admin memperbarui atau memindahkan penetapan greenhouse', meta: { greenhouse_ids: ids } });
    return userWithGreenhouse(await db('users').where({ id: userId }).first());
  });

  app.delete('/users/:id', { onRequest: admin, schema: { tags, security, summary: 'Hapus akun (admin)', params: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } } }, async (request, reply) => {
    if (request.params.id === request.auth.id) throw httpError(400, 'Admin tidak dapat menghapus akunnya sendiri', 'SELF_DELETE');
    const target = await db('users').where({ id: request.params.id }).first();
    if (!target) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
    await db('users').where({ id: target.id }).delete();
    await logActivity(request, { action: 'user.delete', entity: 'user', entity_id: target.id, description: `Admin menghapus akun ${target.username}` });
    return reply.code(204).send();
  });
}
