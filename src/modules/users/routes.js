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

export default async function userRoutes(app) {
  const auth = [app.authenticate];
  const writers = [app.authenticate, app.requireRole('admin', 'operator')];
  const adminOnly = [app.authenticate, app.requireRole('admin')];

  app.get('/users/me', { onRequest: auth, schema: { tags, security, summary: 'Profil saya (termasuk info greenhouse)' } },
    async (request) => userWithGreenhouse(request.auth));

  app.patch('/users/me', {
    onRequest: auth,
    schema: {
      tags, security, summary: 'Edit profil: nama, email, telepon, jabatan',
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 100 },
          email: { type: 'string', format: 'email', maxLength: 190 },
          phone: { type: ['string', 'null'], maxLength: 30 },
          job_title: { type: ['string', 'null'], maxLength: 100 },
        },
      },
    },
  }, async (request) => {
    const patch = { ...request.body };
    if (patch.email) {
      patch.email = patch.email.trim().toLowerCase();
      const taken = await db('users').where({ email: patch.email }).whereNot({ id: request.auth.id }).first();
      if (taken) throw httpError(409, 'Email sudah dipakai akun lain', 'EMAIL_TAKEN');
    }
    await db('users').where({ id: request.auth.id }).update({ ...patch, updated_at: now() });
    await logActivity(request, { action: 'user.update_profile', entity: 'user', entity_id: request.auth.id, description: 'Memperbarui profil', meta: { fields: Object.keys(patch) } });
    return userWithGreenhouse(await db('users').where({ id: request.auth.id }).first());
  });

  // Informasi rumah kaca. Jika akun belum punya greenhouse, endpoint ini membuatkannya.
  app.put('/users/me/greenhouse', {
    onRequest: writers,
    schema: {
      tags, security, summary: 'Isi/ubah informasi greenhouse milik akun',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 150 },
          location: { type: ['string', 'null'], maxLength: 255 },
          plant_type: { type: ['string', 'null'], maxLength: 100 },
          area_m2: { type: ['number', 'null'], minimum: 0 },
          description: { type: ['string', 'null'], maxLength: 1000 },
        },
      },
    },
  }, async (request) => {
    const t = now();
    let ghId = request.auth.greenhouse_id;
    if (ghId) {
      await db('greenhouses').where({ id: ghId }).update({ ...request.body, updated_at: t });
    } else {
      ghId = newId();
      await db.transaction(async (trx) => {
        await trx('greenhouses').insert({ id: ghId, ...request.body, created_at: t, updated_at: t });
        await trx('users').where({ id: request.auth.id }).update({ greenhouse_id: ghId, updated_at: t });
      });
    }
    await logActivity(request, { action: 'greenhouse.upsert', entity: 'greenhouse', entity_id: ghId, description: `Memperbarui greenhouse ${request.body.name}`, greenhouse_id: ghId });
    return userWithGreenhouse(await db('users').where({ id: request.auth.id }).first());
  });

  // ---- Admin ----
  app.get('/users', {
    onRequest: adminOnly,
    schema: { tags, security, summary: 'Daftar pengguna (admin)', querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, q: { type: 'string' } } } },
  }, async (request) => {
    const { page, limit, offset } = pageParams(request.query);
    const base = db('users');
    if (request.query.q) base.where((b) => b.where('name', 'like', contains(request.query.q)).orWhere('email', 'like', contains(request.query.q)));
    const [{ total }] = await base.clone().count({ total: '*' });
    const rows = await base.orderBy('created_at', 'desc').limit(limit).offset(offset);
    return { data: rows.map((r) => dto(r, { omit: ['password_hash'] })), meta: pageMeta(page, limit, Number(total)) };
  });

  app.patch('/users/:id', {
    onRequest: adminOnly,
    schema: {
      tags, security, summary: 'Ubah role / status / greenhouse pengguna (admin)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          role: { type: 'string', enum: ['admin', 'operator', 'viewer'] },
          is_active: { type: 'boolean' },
          job_title: { type: ['string', 'null'] },
          greenhouse_id: { type: ['string', 'null'] },
        },
      },
    },
  }, async (request) => {
    const target = await db('users').where({ id: request.params.id }).first();
    if (!target) throw httpError(404, 'Pengguna tidak ditemukan', 'USER_NOT_FOUND');
    if (target.id === request.auth.id && (request.body.role && request.body.role !== 'admin' || request.body.is_active === false)) {
      throw httpError(400, 'Tidak dapat menurunkan role atau menonaktifkan akun sendiri', 'SELF_MODIFY');
    }
    if (request.body.greenhouse_id && !(await db('greenhouses').where({ id: request.body.greenhouse_id }).first())) {
      throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    }
    await db('users').where({ id: target.id }).update({ ...request.body, updated_at: now() });
    await logActivity(request, { action: 'user.admin_update', entity: 'user', entity_id: target.id, description: `Admin memperbarui pengguna ${target.email}`, meta: request.body });
    return userWithGreenhouse(await db('users').where({ id: target.id }).first());
  });
}
