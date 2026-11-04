import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toJson } from '../../lib/json.js';
import { now, toMs } from '../../lib/time.js';
import { ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { calibrationOverview, defaultDueAt } from '../../services/calibration.js';
import { RPC } from '../../config/contract.js';
import { sendCommand } from '../../services/deviceCommand.js';

const tags = ['Calibrations'];
const security = [{ bearerAuth: [] }];

export default async function calibrationRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')];

  async function loadSensor(id, scope) {
    const q = db('sensors').join('devices', 'devices.id', 'sensors.device_id').where('sensors.id', id);
    if (scope) q.andWhere('devices.greenhouse_id', scope);
    const row = await q
      .select('sensors.*', 'devices.name as device_name', 'devices.tb_device_id as tb_device_id', 'devices.greenhouse_id as greenhouse_id')
      .first();
    if (!row) throw httpError(404, 'Sensor tidak ditemukan', 'SENSOR_NOT_FOUND');
    return row;
  }

  app.get('/calibrations', {
    onRequest: ro,
    schema: { tags, security, summary: 'Status kalibrasi tiap sensor + tanggal kalibrasi terakhir', querystring: { type: 'object', properties: { device_id: { type: 'string' }, greenhouse_id: { type: 'string' } } } },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('sensors').join('devices', 'devices.id', 'sensors.device_id').select('sensors.*');
    if (scope) q.where('devices.greenhouse_id', scope);
    if (request.query.device_id) q.where('sensors.device_id', request.query.device_id);
    return { data: await calibrationOverview(await q) };
  });

  app.get('/sensors/:id/calibrations', {
    onRequest: ro,
    schema: { tags, security, summary: 'Riwayat kalibrasi sebuah sensor', params: { type: 'object', properties: { id: { type: 'string' } } } },
  }, async (request) => {
    const sensor = await loadSensor(request.params.id, ghScope(request));
    const rows = await db('sensor_calibrations').where({ sensor_id: sensor.id }).orderBy('calibrated_at', 'desc').limit(100);
    return { sensor: dto(sensor, { omit: ['tb_device_id'] }), data: rows.map((r) => dto(r, { json: ['reference_values'] })) };
  });

  app.post('/sensors/:id/calibrations', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Catat kalibrasi sensor (send_to_device belum didukung service_1.py; biarkan false)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        properties: {
          calibrated_at: { type: 'string', description: 'ISO 8601; default sekarang' },
          next_due_at: { type: 'string', description: 'ISO 8601; default mengikuti interval jenis sensor' },
          method: { type: 'string', maxLength: 150 },
          reference_values: { type: 'object', description: 'Contoh pH: { "buffer": [4.01, 6.86] }' },
          notes: { type: 'string', maxLength: 1000 },
          send_to_device: { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const sensor = await loadSensor(request.params.id, ghScope(request));
    const { send_to_device, reference_values, next_due_at, calibrated_at, ...rest } = request.body;

    let device_command = null;
    if (send_to_device) {
      if (!sensor.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');
      const params = { sensor: sensor.type, key: sensor.tb_key, reference_values: reference_values ?? null };
      const device = await db('devices').where({ id: sensor.device_id }).first();
      device_command = { method: RPC.calibrate, params, response: await sendCommand(device, RPC.calibrate, params) };
    }

    const calibratedAt = toMs(calibrated_at, now());
    const row = {
      id: newId(),
      sensor_id: sensor.id,
      calibrated_at: calibratedAt,
      due_at: toMs(next_due_at, defaultDueAt(sensor.type, calibratedAt)),
      reference_values: toJson(reference_values),
      performed_by: request.auth.id,
      created_at: now(),
      ...rest,
    };
    await db('sensor_calibrations').insert(row);
    await logActivity(request, { action: 'sensor.calibrate', entity: 'sensor', entity_id: sensor.id, description: `Kalibrasi ${sensor.name} (${sensor.device_name})`, meta: { send_to_device: Boolean(send_to_device) }, greenhouse_id: sensor.greenhouse_id });
    return reply.code(201).send({ ...dto(row, { json: ['reference_values'] }), device_command });
  });
}
