import { db } from '../../db/knex.js';
import { METRIC_NAMES } from '../../config/metrics.js';
import { dto } from '../../lib/dto.js';
import { toCsv } from '../../lib/csv.js';
import { startsWith } from '../../lib/like.js';
import { findDevice } from '../../lib/devices.js';
import { httpError } from '../../lib/errors.js';
import { pageMeta, pageParams } from '../../lib/pagination.js';
import { ghScope } from '../../lib/scope.js';
import { now, parseInterval, toMs, toWib } from '../../lib/time.js';
import { parseJson } from '../../lib/json.js';
import { getHistory } from '../../services/telemetry.js';

const tags = ['Telemetry & Logs'];
const security = [{ bearerAuth: [] }];

const historyQuery = {
  type: 'object',
  required: ['device_id'],
  properties: {
    device_id: { type: 'string' },
    metrics: { type: 'string', description: `Pisahkan dengan koma. Pilihan: ${METRIC_NAMES.join(', ')}. Default semua.` },
    from: { type: 'string', description: 'ISO 8601 atau epoch ms. Default 24 jam terakhir.' },
    to: { type: 'string', description: 'ISO 8601 atau epoch ms. Default sekarang.' },
    interval: { type: 'string', pattern: '^\\d+(s|m|h|d)$', description: 'Contoh 5m, 1h. Dipakai bersama agg.' },
    agg: { type: 'string', enum: ['none', 'avg', 'min', 'max'], default: 'none' },
    limit: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
  },
};

async function resolveHistory(request) {
  const q = request.query;
  const device = await findDevice(q.device_id, ghScope(request));
  const metrics = q.metrics ? q.metrics.split(',').map((s) => s.trim()).filter((m) => METRIC_NAMES.includes(m)) : METRIC_NAMES;
  if (!metrics.length) throw httpError(400, `metrics tidak valid. Pilihan: ${METRIC_NAMES.join(', ')}`, 'INVALID_METRICS');
  const endTs = toMs(q.to, now());
  const startTs = toMs(q.from, endTs - 24 * 3_600_000);
  if (startTs >= endTs) throw httpError(400, 'Rentang waktu tidak valid (from harus lebih awal dari to)', 'INVALID_RANGE');
  const agg = q.agg && q.agg !== 'none' ? q.agg.toUpperCase() : 'NONE';
  const interval = parseInterval(q.interval) || (agg !== 'NONE' ? Math.max(60_000, Math.ceil((endTs - startTs) / 200)) : undefined);
  const points = await getHistory(device, { metrics, startTs, endTs, interval, agg, limit: q.limit || 1000 });
  return { device, metrics, startTs, endTs, points };
}

export default async function telemetryRoutes(app) {
  const ro = [app.authenticate];

  app.get('/telemetry/history', { onRequest: ro, schema: { tags, security, summary: 'Riwayat data sensor berkala', querystring: historyQuery } }, async (request) => {
    const { device, metrics, startTs, endTs, points } = await resolveHistory(request);
    return {
      device_id: device.id,
      from: new Date(startTs).toISOString(),
      to: new Date(endTs).toISOString(),
      metrics,
      count: points.length,
      data: points.map((p) => ({ ...p, ts: new Date(p.ts).toISOString() })),
    };
  });

  app.get('/telemetry/export', { onRequest: ro, schema: { tags, security, summary: 'Ekspor riwayat telemetri ke CSV', querystring: historyQuery } }, async (request, reply) => {
    const { device, metrics, startTs, endTs, points } = await resolveHistory(request);
    const columns = [
      { key: 'timestamp', header: 'timestamp_utc' },
      { key: 'wib', header: 'waktu_wib' },
      ...metrics.map((m) => ({ key: m, header: m })),
    ];
    const rows = points.map((p) => ({ ...p, timestamp: new Date(p.ts).toISOString(), wib: toWib(p.ts) }));
    const stamp = (ms) => new Date(ms).toISOString().slice(0, 10);
    const safe = device.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="telemetri-${safe}-${stamp(startTs)}_${stamp(endTs)}.csv"`)
      .send(toCsv(columns, rows));
  });

  // ---- Log aktivitas ----
  const logQuery = {
    type: 'object',
    properties: {
      page: { type: 'integer' }, limit: { type: 'integer' },
      action: { type: 'string', description: 'Awalan aksi, mis. actuator, auth, sensor' },
      user_id: { type: 'string' }, from: { type: 'string' }, to: { type: 'string' }, greenhouse_id: { type: 'string' },
    },
  };

  function logsQuery(request) {
    const scope = ghScope(request);
    const q = db('activity_logs')
      .leftJoin('users', 'users.id', 'activity_logs.user_id')
      .select('activity_logs.*', 'users.name as user_name');
    if (scope) q.where('activity_logs.greenhouse_id', scope);
    const { action, user_id, from, to } = request.query;
    if (action) q.where('activity_logs.action', 'like', startsWith(action));
    if (user_id) q.where('activity_logs.user_id', user_id);
    if (from) q.where('activity_logs.created_at', '>=', toMs(from, 0));
    if (to) q.where('activity_logs.created_at', '<=', toMs(to, now()));
    return q.orderBy('activity_logs.created_at', 'desc');
  }

  app.get('/activity-logs', { onRequest: ro, schema: { tags, security, summary: 'Log aktivitas pengguna dan sistem', querystring: logQuery } }, async (request) => {
    const { page, limit, offset } = pageParams(request.query);
    const base = logsQuery(request);
    const [{ total }] = await db.from(base.clone().clearSelect().clearOrder().select('activity_logs.id').as('t')).count({ total: '*' });
    const rows = await base.limit(limit).offset(offset);
    return { data: rows.map((r) => dto(r, { json: ['meta'] })), meta: pageMeta(page, limit, Number(total)) };
  });

  app.get('/activity-logs/export', { onRequest: ro, schema: { tags, security, summary: 'Ekspor log aktivitas ke CSV (maks. 5000 baris)', querystring: logQuery } }, async (request, reply) => {
    const rows = await logsQuery(request).limit(5000);
    const csv = toCsv(
      [
        { key: 'created_at', header: 'timestamp_utc' },
        { key: 'wib', header: 'waktu_wib' },
        { key: 'user_name', header: 'pengguna' },
        { key: 'action', header: 'aksi' },
        { key: 'entity', header: 'entitas' },
        { key: 'description', header: 'keterangan' },
        { key: 'ip', header: 'ip' },
      ],
      rows.map((r) => ({ ...r, created_at: new Date(Number(r.created_at)).toISOString(), wib: toWib(r.created_at), meta: parseJson(r.meta) ? JSON.stringify(parseJson(r.meta)) : '' })),
    );
    return reply
      .header('Content-Type', 'text/csv; charset=utf-8')
      .header('Content-Disposition', `attachment; filename="log-aktivitas-${new Date().toISOString().slice(0, 10)}.csv"`)
      .send(csv);
  });
}
