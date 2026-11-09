import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { now } from '../../lib/time.js';
import { ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';

const tags = ['Greenhouses'];
const security = [{ bearerAuth: [] }];
const idParam = { type: 'object', required: ['id'], properties: { id: { type: 'string' } } };
const greenhouseFields = {
  name: { type: 'string', minLength: 2, maxLength: 150 },
  location: { type: ['string', 'null'], maxLength: 255 },
  plant_type: { type: ['string', 'null'], maxLength: 100 },
  area_m2: { type: ['number', 'null'], minimum: 0 },
  description: { type: ['string', 'null'], maxLength: 1000 },
};

async function assignedTo(user, greenhouseId) {
  const row = await db('user_greenhouses').where({ user_id: user.id, greenhouse_id: greenhouseId }).first();
  return Boolean(row || user.greenhouse_id === greenhouseId);
}

export default async function greenhouseRoutes(app) {
  const auth = [app.authenticate];
  const admin = [app.authenticate, app.requireRole('admin')];

  app.get('/greenhouses', { onRequest: auth, schema: { tags, security, summary: 'Daftar greenhouse sesuai hak akses', querystring: { type: 'object', properties: { q: { type: 'string' } } } } }, async (request) => {
    let rows;
    if (request.auth.role === 'admin') rows = await db('greenhouses').orderBy('created_at', 'desc');
    else rows = await db('user_greenhouses').join('greenhouses', 'greenhouses.id', 'user_greenhouses.greenhouse_id').where('user_greenhouses.user_id', request.auth.id).select('greenhouses.*').orderBy('greenhouses.created_at', 'desc');
    if (!rows.length && request.auth.role !== 'admin' && request.auth.greenhouse_id) rows = await db('greenhouses').where({ id: request.auth.greenhouse_id });
    if (request.query.q) rows = rows.filter((g) => `${g.name} ${g.location || ''}`.toLowerCase().includes(request.query.q.toLowerCase()));
    const data = await Promise.all(rows.map(async (g) => {
      const owner = await db('user_greenhouses').join('users', 'users.id', 'user_greenhouses.user_id').where('user_greenhouses.greenhouse_id', g.id).select('users.id', 'users.name', 'users.username').first();
      const count = await db('devices').where({ greenhouse_id: g.id }).count({ n: '*' }).first();
      return { ...dto(g), owner: owner || null, device_count: Number(count.n) };
    }));
    return { data };
  });

  app.get('/greenhouses/:id', { onRequest: auth, schema: { tags, security, summary: 'Detail greenhouse dan daftar device', params: idParam } }, async (request) => {
    if (request.auth.role !== 'admin' && !(await assignedTo(request.auth, request.params.id))) throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    const greenhouse = await db('greenhouses').where({ id: request.params.id }).first();
    if (!greenhouse) throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    const devices = await db('devices').where({ greenhouse_id: greenhouse.id }).orderBy('created_at');
    const owner = await db('user_greenhouses').join('users', 'users.id', 'user_greenhouses.user_id').where('user_greenhouses.greenhouse_id', greenhouse.id).select('users.id', 'users.name', 'users.username').first();
    return { ...dto(greenhouse), owner: owner || null, devices: devices.map((d) => ({ id: d.id, name: d.name, type: d.type, zone: d.zone })) };
  });

  app.post('/greenhouses', { onRequest: admin, schema: { tags, security, summary: 'Buat greenhouse (admin)', body: { type: 'object', additionalProperties: false, required: ['name'], properties: greenhouseFields } } }, async (request, reply) => {
    const t = now(); const id = newId();
    await db('greenhouses').insert({ id, ...request.body, created_at: t, updated_at: t });
    await logActivity(request, { action: 'greenhouse.create', entity: 'greenhouse', entity_id: id, description: `Admin membuat greenhouse ${request.body.name}`, greenhouse_id: id });
    return reply.code(201).send(dto(await db('greenhouses').where({ id }).first()));
  });

  app.patch('/greenhouses/:id', {
    onRequest: auth,
    schema: { tags, security, summary: 'Ubah informasi greenhouse (admin atau pemilik)', params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: greenhouseFields } },
  }, async (request) => {
    const id = request.params.id;
    if (request.auth.role !== 'admin' && !(await assignedTo(request.auth, id))) throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    const greenhouse = await db('greenhouses').where({ id }).first();
    if (!greenhouse) throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    await db('greenhouses').where({ id }).update({ ...request.body, updated_at: now() });
    await logActivity(request, { action: 'greenhouse.update', entity: 'greenhouse', entity_id: id, description: `Memperbarui greenhouse ${greenhouse.name}`, greenhouse_id: id, meta: { fields: Object.keys(request.body) } });
    return dto(await db('greenhouses').where({ id }).first());
  });

  app.delete('/greenhouses/:id', { onRequest: admin, schema: { tags, security, summary: 'Hapus greenhouse (admin)', params: idParam } }, async (request, reply) => {
    const row = await db('greenhouses').where({ id: request.params.id }).first();
    if (!row) throw httpError(404, 'Greenhouse tidak ditemukan', 'GREENHOUSE_NOT_FOUND');
    await db('greenhouses').where({ id: row.id }).delete();
    await logActivity(request, { action: 'greenhouse.delete', entity: 'greenhouse', entity_id: row.id, description: `Admin menghapus greenhouse ${row.name}` });
    return reply.code(204).send();
  });
}
