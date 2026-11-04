import { db } from '../../db/knex.js';
import { METRIC_NAMES } from '../../config/metrics.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { pageMeta, pageParams } from '../../lib/pagination.js';
import { now } from '../../lib/time.js';
import { findDevice } from '../../lib/devices.js';
import { ghRequired, ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { evaluateRulesOnce } from '../../services/alertEngine.js';

const tags = ['Alerts & Notifications'];
const security = [{ bearerAuth: [] }];
const idParam = { type: 'object', properties: { id: { type: 'string' } } };

const ruleProps = {
  name: { type: 'string', minLength: 2, maxLength: 150 },
  device_id: { type: ['string', 'null'], description: 'Kosong = berlaku untuk semua perangkat di greenhouse' },
  metric: { type: 'string', enum: METRIC_NAMES },
  operator: { type: 'string', enum: ['<', '<=', '>', '>='] },
  threshold: { type: 'number' },
  severity: { type: 'string', enum: ['info', 'warning', 'critical'] },
  cooldown_minutes: { type: 'integer', minimum: 1, maximum: 1440 },
  is_active: { type: 'boolean' },
};

const ruleDto = (r) => dto(r);

export default async function alertRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')];

  async function loadRule(id, scope) {
    const q = db('alert_rules').where({ id });
    if (scope) q.andWhere({ greenhouse_id: scope });
    const rule = await q.first();
    if (!rule) throw httpError(404, 'Peringatan tidak ditemukan', 'ALERT_NOT_FOUND');
    return rule;
  }

  // ---- Aturan peringatan kustom ----
  app.get('/alerts/rules', { onRequest: ro, schema: { tags, security, summary: 'Daftar aturan peringatan', querystring: { type: 'object', properties: { greenhouse_id: { type: 'string' } } } } }, async (request) => {
    const scope = ghScope(request);
    const q = db('alert_rules').orderBy('created_at', 'desc');
    if (scope) q.where({ greenhouse_id: scope });
    return { data: (await q).map(ruleDto) };
  });

  app.get('/alerts/rules/:id', { onRequest: ro, schema: { tags, security, summary: 'Detail aturan peringatan', params: idParam } }, async (request) =>
    ruleDto(await loadRule(request.params.id, ghScope(request))));

  app.post('/alerts/rules', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Tambah peringatan berdasarkan ambang batas sensor (muncul sebagai notifikasi di aplikasi)',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name', 'metric', 'operator', 'threshold'],
        properties: { ...ruleProps, greenhouse_id: { type: 'string' } },
      },
    },
  }, async (request, reply) => {
    const greenhouse_id = ghRequired(request);
    const { greenhouse_id: _g, device_id = null, ...rest } = request.body;
    if (device_id) await findDevice(device_id, greenhouse_id);
    const t = now();
    const row = {
      id: newId(),
      greenhouse_id,
      device_id,
      created_by: request.auth.id,
      severity: 'warning',
      cooldown_minutes: 15,
      ...rest,
      created_at: t,
      updated_at: t,
    };
    await db('alert_rules').insert(row);
    await logActivity(request, { action: 'alert.create', entity: 'alert_rule', entity_id: row.id, description: `Membuat peringatan "${row.name}"`, greenhouse_id });
    return reply.code(201).send(ruleDto(row));
  });

  app.patch('/alerts/rules/:id', {
    onRequest: rw,
    schema: { tags, security, summary: 'Edit peringatan (termasuk aktif/nonaktif)', params: idParam, body: { type: 'object', additionalProperties: false, minProperties: 1, properties: ruleProps } },
  }, async (request) => {
    const rule = await loadRule(request.params.id, ghScope(request));
    const patch = { ...request.body };
    if (patch.device_id) await findDevice(patch.device_id, rule.greenhouse_id);
    await db('alert_rules').where({ id: rule.id }).update({ ...patch, updated_at: now() });
    await logActivity(request, { action: 'alert.update', entity: 'alert_rule', entity_id: rule.id, description: `Mengubah peringatan "${rule.name}"`, greenhouse_id: rule.greenhouse_id });
    return ruleDto(await db('alert_rules').where({ id: rule.id }).first());
  });

  app.delete('/alerts/rules/:id', { onRequest: rw, schema: { tags, security, summary: 'Hapus peringatan', params: idParam } }, async (request, reply) => {
    const rule = await loadRule(request.params.id, ghScope(request));
    await db('alert_rules').where({ id: rule.id }).delete();
    await logActivity(request, { action: 'alert.delete', entity: 'alert_rule', entity_id: rule.id, description: `Menghapus peringatan "${rule.name}"`, greenhouse_id: rule.greenhouse_id });
    return reply.code(204).send();
  });

  // Jalankan pengecekan sekarang (berguna untuk demo/pengujian)
  app.post('/alerts/evaluate', { onRequest: [app.authenticate, app.requireRole('admin', 'operator')], schema: { tags, security, summary: 'Jalankan pengecekan ambang batas sekarang' } }, async (request) =>
    evaluateRulesOnce(request.log));

  // ---- Notifikasi (riwayat peringatan yang terpicu) ----
  app.get('/alerts/notifications', {
    onRequest: ro,
    schema: {
      tags, security, summary: 'Daftar notifikasi/peringatan yang terpicu',
      querystring: { type: 'object', properties: { page: { type: 'integer' }, limit: { type: 'integer' }, unread: { type: 'boolean' }, severity: { type: 'string', enum: ['info', 'warning', 'critical'] }, source: { type: 'string', enum: ['sensor', 'ai'] }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const { page, limit, offset } = pageParams(request.query);
    const q = db('alert_events').leftJoin('devices', 'devices.id', 'alert_events.device_id').select('alert_events.*', 'devices.name as device_name');
    if (scope) q.where('alert_events.greenhouse_id', scope);
    if (request.query.unread) q.whereNull('alert_events.read_at');
    if (request.query.severity) q.where('alert_events.severity', request.query.severity);
    if (request.query.source) q.where('alert_events.source', request.query.source);
    const [{ total }] = await db.from(q.clone().clearSelect().select('alert_events.id').as('t')).count({ total: '*' });
    const rows = await q.orderBy('alert_events.created_at', 'desc').limit(limit).offset(offset);
    return { data: rows.map((r) => dto(r)), meta: pageMeta(page, limit, Number(total)) };
  });

  app.get('/alerts/notifications/unread-count', { onRequest: ro, schema: { tags, security, summary: 'Jumlah notifikasi belum dibaca' } }, async (request) => {
    const scope = ghScope(request);
    const q = db('alert_events').whereNull('read_at');
    if (scope) q.where({ greenhouse_id: scope });
    const row = await q.count({ n: '*' }).first();
    return { unread: Number(row?.n || 0) };
  });

  app.post('/alerts/notifications/read-all', { onRequest: ro, schema: { tags, security, summary: 'Tandai semua notifikasi sudah dibaca' } }, async (request) => {
    const scope = ghScope(request);
    const q = db('alert_events').whereNull('read_at');
    if (scope) q.where({ greenhouse_id: scope });
    return { updated: await q.update({ read_at: now() }) };
  });

  app.patch('/alerts/notifications/:id/read', { onRequest: ro, schema: { tags, security, summary: 'Tandai notifikasi sudah dibaca', params: idParam } }, async (request) => {
    const scope = ghScope(request);
    const q = db('alert_events').where({ id: request.params.id });
    if (scope) q.andWhere({ greenhouse_id: scope });
    const ev = await q.first();
    if (!ev) throw httpError(404, 'Notifikasi tidak ditemukan', 'NOTIFICATION_NOT_FOUND');
    if (!ev.read_at) await db('alert_events').where({ id: ev.id }).update({ read_at: now() });
    return dto(await db('alert_events').where({ id: ev.id }).first());
  });
}

