import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { now } from '../../lib/time.js';
import { ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { env } from '../../config/env.js';
import { actuatorParams, RPC } from '../../config/contract.js';
import { sendCommand } from '../../services/deviceCommand.js';
import { withLiveActuatorState } from '../../services/telemetry.js';

const tags = ['Actuators'];
const security = [{ bearerAuth: [] }];

export default async function actuatorRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')]; // operator = user yang diberi izin kontrol; viewer hanya baca

  app.get('/actuators', {
    onRequest: ro,
    schema: { tags, security, summary: 'Daftar aktuator beserta state terakhir', querystring: { type: 'object', properties: { device_id: { type: 'string' }, greenhouse_id: { type: 'string' } } } },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('actuators')
      .join('devices', 'devices.id', 'actuators.device_id')
      .select('actuators.*', 'devices.name as device_name', 'devices.mode as device_mode')
      .orderBy('actuators.created_at');
    if (scope) q.where('devices.greenhouse_id', scope);
    if (request.query.device_id) q.where('actuators.device_id', request.query.device_id);
    const rows = await q;
    // state diambil dari telemetri perangkat (status relay), bukan hanya dari perintah terakhir
    const devices = await db('devices').whereIn('id', [...new Set(rows.map((r) => r.device_id))]);
    const grouped = await Promise.all(devices.map((d) => withLiveActuatorState(d, rows.filter((r) => r.device_id === d.id))));
    const order = new Map(rows.map((r, i) => [r.id, i]));
    return { data: grouped.flat().sort((a, b) => order.get(a.id) - order.get(b.id)).map((r) => dto(r)) };
  });

  // Kontrol manual: backend -> ThingsBoard RPC "setActuator" -> Raspberry Pi (MQTT v1/devices/me/rpc/request/+)
  app.post('/actuators/:id/control', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Nyalakan/matikan aktuator (hanya saat mode manual)',
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['state'],
        properties: {
          state: { type: 'string', enum: ['on', 'off'] },
          duration: { type: 'integer', minimum: 1, maximum: env.tb.manualMaxDuration, description: 'Detik. Khusus pompa dosis (pump_ec_a/b, pump_ph_up/down); kosong = durasi di pengaturan perangkat.' },
        },
      },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('actuators').join('devices', 'devices.id', 'actuators.device_id').where('actuators.id', request.params.id);
    if (scope) q.andWhere('devices.greenhouse_id', scope);
    const row = await q
      .select('actuators.*', 'devices.name as device_name', 'devices.mode as device_mode', 'devices.tb_device_id as tb_device_id', 'devices.greenhouse_id as greenhouse_id')
      .first();
    if (!row) throw httpError(404, 'Aktuator tidak ditemukan', 'ACTUATOR_NOT_FOUND');
    if (!row.is_active) throw httpError(409, 'Aktuator sedang dinonaktifkan', 'ACTUATOR_DISABLED');
    if (row.device_mode !== 'manual') {
      throw httpError(409, 'Perangkat berada pada mode otomatis. Ubah ke mode manual untuk mengontrol aktuator.', 'MODE_NOT_MANUAL');
    }
    if (!row.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');

    // Kontrak dengan service: lihat src/config/contract.js
    const params = actuatorParams(row.control_key, request.body.state === 'on', request.body.duration);
    const device = await db('devices').where({ id: row.device_id }).first();
    const rpc = await sendCommand(device, RPC.setActuator, params);

    const t = now();
    await db('actuators').where({ id: row.id }).update({ state: request.body.state, last_command_at: t, last_command_by: request.auth.id });
    await logActivity(request, {
      action: 'actuator.control',
      entity: 'actuator',
      entity_id: row.id,
      description: `${row.name} (${row.device_name}) ${request.body.state === 'on' ? 'dinyalakan' : 'dimatikan'}`,
      meta: { method: RPC.setActuator, params },
      greenhouse_id: row.greenhouse_id,
    });
    return {
      actuator: dto(await db('actuators').where({ id: row.id }).first()),
      command: { method: RPC.setActuator, params },
      device_response: rpc ?? null,
    };
  });
}
