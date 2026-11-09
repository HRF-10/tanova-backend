import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { httpError } from '../../lib/errors.js';
import { newId } from '../../lib/ids.js';
import { toJson } from '../../lib/json.js';
import { now } from '../../lib/time.js';
import { deviceDto, findDevice } from '../../lib/devices.js';
import { encrypt } from '../../lib/crypto.js';
import { ghRequired, ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { getConnectionStatus } from '../../services/telemetry.js';
import { SHARED_ATTR } from '../../config/contract.js';
import { forgetSessions, tbFor } from '../../services/thingsboard.js';
import { METRICS } from '../../config/metrics.js';

const tags = ['Devices'];
const security = [{ bearerAuth: [] }];
const SENSOR_TYPES = ['ph', 'ec', 'tds', 'water_temp', 'tank_level', 'other'];
const ACTUATOR_TYPES = ['pump', 'dosing_pump', 'valve', 'fan', 'heater', 'light', 'other'];
const idParam = { type: 'object', properties: { id: { type: 'string' } } };

// Koneksi ThingsBoard milik pengguna (diisi dari GUI). Password disimpan terenkripsi dan tidak pernah dikembalikan.
const connectionProps = {
  tb_device_id: { type: ['string', 'null'], maxLength: 64, description: 'Device ID (UUID) dari ThingsBoard: Copy device ID' },
  tb_url: { type: ['string', 'null'], format: 'uri', maxLength: 255, description: 'Alamat web ThingsBoard, contoh https://thingsboard.cloud. Kosong = TB_URL di .env' },
  tb_username: { type: ['string', 'null'], maxLength: 190, description: 'Email akun ThingsBoard' },
  tb_password: { type: ['string', 'null'], maxLength: 200, description: 'Password akun ThingsBoard. Kosongkan saat edit bila tidak diubah' },
};

// Ubah tb_password (teks) menjadi tb_password_enc untuk disimpan
function applyCredentials(input) {
  const out = { ...input };
  if ('tb_password' in out) {
    out.tb_password_enc = out.tb_password ? encrypt(out.tb_password) : null;
    delete out.tb_password;
  }
  return out;
}

const sensorBody = {
  type: 'object',
  additionalProperties: false,
  required: ['type', 'name'],
  properties: {
    type: { type: 'string', enum: SENSOR_TYPES },
    name: { type: 'string', minLength: 1, maxLength: 100 },
    unit: { type: 'string', maxLength: 20 },
    tb_key: { type: 'string', maxLength: 60 },
    is_active: { type: 'boolean' },
  },
};
const actuatorBody = {
  type: 'object',
  additionalProperties: false,
  required: ['name', 'control_key'],
  properties: {
    name: { type: 'string', minLength: 1, maxLength: 100 },
    type: { type: 'string', enum: ACTUATOR_TYPES },
    control_key: { type: 'string', pattern: '^[a-z0-9_]{1,60}$' },
    is_active: { type: 'boolean' },
  },
};

const DEFAULT_SENSORS = [
  { type: 'ph', name: 'Sensor pH' },
  { type: 'ec', name: 'Sensor EC/TDS' },
  { type: 'water_temp', name: 'Sensor Suhu Air' },
  { type: 'air_temp', name: 'Sensor Suhu Udara' },
  { type: 'humidity', name: 'Sensor Kelembapan' },
  { type: 'waterflow', name: 'Sensor Aliran Air' },
];

// Relay yang dikendalikan raspi/service_1.py (control_key harus sama persis)
export const DEFAULT_ACTUATORS = [
  { name: 'Pompa Nutrisi A', type: 'dosing_pump', control_key: 'pump_ec_a' },
  { name: 'Pompa Nutrisi B', type: 'dosing_pump', control_key: 'pump_ec_b' },
  { name: 'Pompa pH Up', type: 'dosing_pump', control_key: 'pump_ph_up' },
  { name: 'Pompa pH Down', type: 'dosing_pump', control_key: 'pump_ph_down' },
  { name: 'Pompa Utama A', type: 'pump', control_key: 'pump_a' },
  { name: 'Pompa Utama B', type: 'pump', control_key: 'pump_b' },
  { name: 'Kipas', type: 'fan', control_key: 'fan' },
  { name: 'Pemanas', type: 'heater', control_key: 'heater' },
];

const sensorRow = (deviceId, s, t) => ({
  id: newId(),
  device_id: deviceId,
  type: s.type,
  name: s.name,
  unit: s.unit ?? (METRICS[s.type]?.unit || null),
  tb_key: s.tb_key ?? (METRICS[s.type]?.tbKey || null),
  is_active: s.is_active ?? true,
  created_at: t,
});
const actuatorRow = (deviceId, a, t) => ({
  id: newId(),
  device_id: deviceId,
  name: a.name,
  type: a.type ?? 'pump',
  control_key: a.control_key,
  state: 'off',
  is_active: a.is_active ?? true,
  created_at: t,
});

export const sensorDto = (r) => dto(r);
export const actuatorDto = (r) => dto(r);

export default async function deviceRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')];

  async function loadChildren(deviceIds) {
    const [sensors, actuators] = await Promise.all([
      db('sensors').whereIn('device_id', deviceIds).orderBy('created_at'),
      db('actuators').whereIn('device_id', deviceIds).orderBy('created_at'),
    ]);
    return { sensors, actuators };
  }

  const connection = (device) => getConnectionStatus(device);

  app.get('/devices/summary', { onRequest: ro, schema: { tags, security, summary: 'Ringkasan perangkat: total, terhubung, sensor aktif, aktuator aktif' } },
    async (request) => {
      const scope = ghScope(request);
      const q = db('devices');
      if (scope) q.where({ greenhouse_id: scope });
      const devices = await q;
      const ids = devices.map((d) => d.id);
      const { sensors, actuators } = ids.length ? await loadChildren(ids) : { sensors: [], actuators: [] };
      const conns = await Promise.all(devices.map(connection));
      return {
        total_devices: devices.length,
        connected_devices: conns.filter((c) => c.online).length,
        active_sensors: sensors.filter((s) => s.is_active).length,
        active_actuators: actuators.filter((a) => a.is_active).length,
        actuators_on: actuators.filter((a) => a.state === 'on').length,
      };
    });

  app.get('/devices', {
    onRequest: ro,
    schema: { tags, security, summary: 'Daftar perangkat beserta zona, status koneksi, sensor dan aktuator', querystring: { type: 'object', properties: { zone: { type: 'string' }, greenhouse_id: { type: 'string' } } } },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('devices').orderBy('created_at', 'asc');
    if (scope) q.where({ greenhouse_id: scope });
    if (request.query.zone) q.where({ zone: request.query.zone });
    const devices = await q;
    if (!devices.length) return { data: [] };
    const { sensors, actuators } = await loadChildren(devices.map((d) => d.id));
    const conns = await Promise.all(devices.map(connection));
    return {
      data: devices.map((d, i) => ({
        ...deviceDto(d),
        connection: conns[i],
        sensors: sensors.filter((s) => s.device_id === d.id).map(sensorDto),
        actuators: actuators.filter((a) => a.device_id === d.id).map(actuatorDto),
      })),
    };
  });

  app.get('/devices/:id', { onRequest: ro, schema: { tags, security, summary: 'Detail perangkat', params: idParam } }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    const { sensors, actuators } = await loadChildren([device.id]);
    return {
      ...deviceDto(device),
      connection: await connection(device),
      sensors: sensors.map(sensorDto),
      actuators: actuators.map(actuatorDto),
    };
  });

  app.post('/devices', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Tambah perangkat (sensor dan aktuator bawaan sesuai service_1.py dibuat otomatis jika tidak diisi)',
      body: {
        type: 'object',
        additionalProperties: false,
        required: ['name'],
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 150 },
          zone: { type: 'string', maxLength: 100 },
          type: { type: 'string', maxLength: 30 },
          ...connectionProps,
          mode: { type: 'string', enum: ['manual', 'auto'] },
          config: { type: 'object' },
          notes: { type: 'string', maxLength: 1000 },
          greenhouse_id: { type: 'string' },
          sensors: { type: 'array', items: sensorBody, maxItems: 20 },
          actuators: { type: 'array', items: actuatorBody, maxItems: 20 },
        },
      },
    },
  }, async (request, reply) => {
    const { sensors = DEFAULT_SENSORS, actuators = DEFAULT_ACTUATORS, config, greenhouse_id: _g, ...restBody } = request.body;
    const rest = applyCredentials(restBody);
    const greenhouse_id = ghRequired(request);
    const keys = actuators.map((a) => a.control_key);
    if (new Set(keys).size !== keys.length) throw httpError(400, 'control_key aktuator harus unik', 'DUPLICATE_CONTROL_KEY');

    const t = now();
    const id = newId();
    await db.transaction(async (trx) => {
      await trx('devices').insert({ id, greenhouse_id, ...rest, config: toJson(config), created_at: t, updated_at: t });
      if (sensors.length) await trx('sensors').insert(sensors.map((s) => sensorRow(id, s, t)));
      if (actuators.length) await trx('actuators').insert(actuators.map((a) => actuatorRow(id, a, t)));
    });
    await logActivity(request, { action: 'device.create', entity: 'device', entity_id: id, description: `Menambah perangkat ${rest.name}`, greenhouse_id });
    const device = await db('devices').where({ id }).first();
    const children = await loadChildren([id]);
    return reply.code(201).send({
      ...deviceDto(device),
      sensors: children.sensors.map(sensorDto),
      actuators: children.actuators.map(actuatorDto),
    });
  });

  app.patch('/devices/:id', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Ubah perangkat', params: idParam,
      body: {
        type: 'object',
        additionalProperties: false,
        minProperties: 1,
        properties: {
          name: { type: 'string', minLength: 2, maxLength: 150 },
          zone: { type: ['string', 'null'], maxLength: 100 },
          type: { type: 'string', maxLength: 30 },
          ...connectionProps,
          config: { type: ['object', 'null'] },
          notes: { type: ['string', 'null'], maxLength: 1000 },
        },
      },
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    const patch = applyCredentials(request.body);
    if ('config' in patch) patch.config = toJson(patch.config);
    await db('devices').where({ id: device.id }).update({ ...patch, updated_at: now() });
    if ('tb_password_enc' in patch || 'tb_username' in patch || 'tb_url' in patch) forgetSessions();
    await logActivity(request, { action: 'device.update', entity: 'device', entity_id: device.id, description: `Mengubah perangkat ${device.name}`, greenhouse_id: device.greenhouse_id });
    return deviceDto(await db('devices').where({ id: device.id }).first());
  });

  app.delete('/devices/:id', { onRequest: [app.authenticate, app.requireRole('admin')], schema: { tags, security, summary: 'Hapus perangkat (admin)', params: idParam } },
    async (request, reply) => {
      const device = await findDevice(request.params.id, ghScope(request));
      await db('devices').where({ id: device.id }).delete();
      await logActivity(request, { action: 'device.delete', entity: 'device', entity_id: device.id, description: `Menghapus perangkat ${device.name}`, greenhouse_id: device.greenhouse_id });
      return reply.code(204).send();
    });

  // Mode sistem: manual | auto. Disimpan sebagai shared attribute "mode" di ThingsBoard agar Raspberry Pi
  // menerimanya saat terhubung (topik MQTT v1/devices/me/attributes).
  app.put('/devices/:id/mode', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Ubah mode sistem (manual / otomatis)', params: idParam,
      body: { type: 'object', additionalProperties: false, required: ['mode'], properties: { mode: { type: 'string', enum: ['manual', 'auto'] } } },
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');
    await tbFor(device).setSharedAttributes(device.tb_device_id, { [SHARED_ATTR.mode]: request.body.mode });
    await db('devices').where({ id: device.id }).update({ mode: request.body.mode, updated_at: now() });
    await logActivity(request, { action: 'device.set_mode', entity: 'device', entity_id: device.id, description: `Mode ${device.name} diubah ke ${request.body.mode}`, meta: { mode: request.body.mode }, greenhouse_id: device.greenhouse_id });
    return { id: device.id, mode: request.body.mode };
  });

  // ---- Koneksi ThingsBoard (diisi pengguna dari GUI) ----
  async function testConnection({ url, username, password, device_id }) {
    try {
      const client = tbFor({ tb_url: url, tb_username: username, tb_password_enc: encrypt(password) });
      const info = await client.ping(device_id);
      const attrs = await client.getAttributes(device_id).catch(() => ({}));
      return { ok: true, device_name: info?.name ?? null, device_type: info?.type ?? null, online: typeof attrs.active === 'boolean' ? attrs.active : null };
    } catch (err) {
      if (!String(err.code || '').startsWith('TB_')) throw err;
      const stage = err.code === 'TB_UNREACHABLE' ? 'network' : err.code === 'TB_AUTH_FAILED' ? 'login' : 'device';
      return { ok: false, stage, code: err.code, message: err.message };
    }
  }

  app.post('/devices/connection/test', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Tes koneksi ThingsBoard sebelum disimpan (login + cek device ID)',
      body: {
        type: 'object', additionalProperties: false, required: ['tb_username', 'tb_password', 'tb_device_id'],
        properties: { tb_url: connectionProps.tb_url, tb_username: { type: 'string', minLength: 1 }, tb_password: { type: 'string', minLength: 1 }, tb_device_id: { type: 'string', minLength: 1 } },
      },
    },
  }, async (request) => {
    const b = request.body;
    return testConnection({ url: b.tb_url || undefined, username: b.tb_username, password: b.tb_password, device_id: b.tb_device_id });
  });

  app.post('/devices/:id/connection/test', { onRequest: rw, schema: { tags, security, summary: 'Tes koneksi ThingsBoard dengan data yang tersimpan', params: idParam } }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) return { ok: false, stage: 'device', code: 'NO_TB_DEVICE', message: 'Device ID ThingsBoard belum diisi' };
    try {
      const client = tbFor(device);
      const info = await client.ping(device.tb_device_id);
      const attrs = await client.getAttributes(device.tb_device_id).catch(() => ({}));
      return { ok: true, device_name: info?.name ?? null, device_type: info?.type ?? null, online: typeof attrs.active === 'boolean' ? attrs.active : null };
    } catch (err) {
      if (err.code === 'NO_TB_CREDENTIALS') return { ok: false, stage: 'login', code: err.code, message: err.message };
      if (!String(err.code || '').startsWith('TB_')) throw err;
      return { ok: false, stage: err.code === 'TB_UNREACHABLE' ? 'network' : err.code === 'TB_AUTH_FAILED' ? 'login' : 'device', code: err.code, message: err.message };
    }
  });

  app.put('/devices/:id/connection', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Simpan koneksi ThingsBoard perangkat (Device ID, URL, akun)', params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: connectionProps },
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    const patch = applyCredentials(request.body);
    const username = 'tb_username' in patch ? patch.tb_username : device.tb_username;
    const hasPassword = 'tb_password_enc' in patch ? Boolean(patch.tb_password_enc) : Boolean(device.tb_password_enc);
    if (username && !hasPassword) throw httpError(400, 'tb_password wajib diisi bersama tb_username', 'VALIDATION_ERROR');
    await db('devices').where({ id: device.id }).update({ ...patch, updated_at: now() });
    forgetSessions();
    await logActivity(request, { action: 'device.update_connection', entity: 'device', entity_id: device.id, description: `Memperbarui koneksi ThingsBoard ${device.name}`, greenhouse_id: device.greenhouse_id });
    return deviceDto(await db('devices').where({ id: device.id }).first());
  });

  // ---- Konfigurasi Wi-Fi untuk Arduino melalui ThingsBoard Shared Attributes ----
  // Password hanya diteruskan ke ThingsBoard dan tidak disimpan/ditampilkan oleh API Tanova.
  app.put('/devices/:id/wifi-config', {
    onRequest: rw,
    schema: {
      tags, security, params: idParam,
      summary: 'Kirim SSID dan password Wi-Fi ke Arduino melalui ThingsBoard',
      description: 'Menulis wifi_ssid dan wifi_password ke Shared Attributes. Arduino mengambilnya melalui subscription/request shared attributes. Respons hanya mengonfirmasi bahwa konfigurasi berhasil ditulis ke ThingsBoard, bukan bahwa Wi-Fi perangkat sudah tersambung.',
      body: {
        type: 'object', additionalProperties: false,
        required: ['ssid', 'password'],
        properties: {
          ssid: { type: 'string', minLength: 1, maxLength: 32 },
          password: { type: 'string', minLength: 0, maxLength: 64 },
        },
      },
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');
    const attrs = { wifi_ssid: request.body.ssid, wifi_password: request.body.password };
    await tbFor(device).setSharedAttributes(device.tb_device_id, attrs);
    await logActivity(request, {
      action: 'device.update_wifi_config', entity: 'device', entity_id: device.id,
      description: `Mengirim konfigurasi Wi-Fi ke ThingsBoard untuk ${device.name}`,
      meta: { wifi_ssid: request.body.ssid, password_sent: true },
      greenhouse_id: device.greenhouse_id,
    });
    return {
      saved: true,
      delivered_to: 'thingsboard_shared_attributes',
      device_received: null,
      message: 'Konfigurasi berhasil ditulis ke ThingsBoard. Status koneksi perangkat akan terlihat setelah Arduino mengambil konfigurasi dan mengirim telemetry.',
    };
  });

  app.get('/devices/:id/wifi-config', {
    onRequest: ro,
    schema: {
      tags, security, params: idParam,
      summary: 'Lihat status konfigurasi Wi-Fi tanpa membuka password',
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');
    const attrs = await tbFor(device).getAttributes(device.tb_device_id, ['wifi_ssid', 'wifi_password'], 'SHARED_SCOPE');
    const status = await getConnectionStatus(device);
    return {
      configured: Boolean(attrs.wifi_ssid && attrs.wifi_password !== undefined),
      ssid: attrs.wifi_ssid || null,
      password_configured: attrs.wifi_password !== undefined,
      connection: {
        status: status.status,
        wifi_connected: status.wifi_connected ?? null,
        mqtt_connected: status.mqtt_connected ?? null,
        last_seen: status.last_seen,
      },
    };
  });

  // ---- Sensors ----
  app.post('/devices/:id/sensors', { onRequest: rw, schema: { tags, security, summary: 'Tambah sensor', params: idParam, body: sensorBody } },
    async (request, reply) => {
      const device = await findDevice(request.params.id, ghScope(request));
      const row = sensorRow(device.id, request.body, now());
      await db('sensors').insert(row);
      await logActivity(request, { action: 'sensor.create', entity: 'sensor', entity_id: row.id, description: `Menambah sensor ${row.name} pada ${device.name}`, greenhouse_id: device.greenhouse_id });
      return reply.code(201).send(sensorDto(row));
    });

  async function findSensor(id, scope) {
    const q = db('sensors').join('devices', 'devices.id', 'sensors.device_id').where('sensors.id', id);
    if (scope) q.andWhere('devices.greenhouse_id', scope);
    const row = await q.select('sensors.*', 'devices.greenhouse_id as greenhouse_id').first();
    if (!row) throw httpError(404, 'Sensor tidak ditemukan', 'SENSOR_NOT_FOUND');
    return row;
  }

  app.patch('/sensors/:id', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Ubah sensor (termasuk aktif/nonaktif)', params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: { ...sensorBody.properties, type: { type: 'string', enum: SENSOR_TYPES } }, required: [] },
    },
  }, async (request) => {
    const s = await findSensor(request.params.id, ghScope(request));
    await db('sensors').where({ id: s.id }).update(request.body);
    await logActivity(request, { action: 'sensor.update', entity: 'sensor', entity_id: s.id, description: `Mengubah sensor ${s.name}`, greenhouse_id: s.greenhouse_id });
    return sensorDto(await db('sensors').where({ id: s.id }).first());
  });

  app.delete('/sensors/:id', { onRequest: rw, schema: { tags, security, summary: 'Hapus sensor', params: idParam } }, async (request, reply) => {
    const s = await findSensor(request.params.id, ghScope(request));
    await db('sensors').where({ id: s.id }).delete();
    await logActivity(request, { action: 'sensor.delete', entity: 'sensor', entity_id: s.id, description: `Menghapus sensor ${s.name}`, greenhouse_id: s.greenhouse_id });
    return reply.code(204).send();
  });

  // ---- Actuators (CRUD) ----
  app.post('/devices/:id/actuators', { onRequest: rw, schema: { tags, security, summary: 'Tambah aktuator', params: idParam, body: actuatorBody } },
    async (request, reply) => {
      const device = await findDevice(request.params.id, ghScope(request));
      if (await db('actuators').where({ device_id: device.id, control_key: request.body.control_key }).first()) {
        throw httpError(409, 'control_key sudah dipakai pada perangkat ini', 'DUPLICATE_CONTROL_KEY');
      }
      const row = actuatorRow(device.id, request.body, now());
      await db('actuators').insert(row);
      await logActivity(request, { action: 'actuator.create', entity: 'actuator', entity_id: row.id, description: `Menambah aktuator ${row.name} pada ${device.name}`, greenhouse_id: device.greenhouse_id });
      return reply.code(201).send(actuatorDto(row));
    });

  app.patch('/actuators/:id', {
    onRequest: rw,
    schema: {
      tags, security, summary: 'Ubah aktuator', params: idParam,
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: actuatorBody.properties },
    },
  }, async (request) => {
    const scope = ghScope(request);
    const q = db('actuators').join('devices', 'devices.id', 'actuators.device_id').where('actuators.id', request.params.id);
    if (scope) q.andWhere('devices.greenhouse_id', scope);
    const a = await q.select('actuators.*', 'devices.greenhouse_id as greenhouse_id').first();
    if (!a) throw httpError(404, 'Aktuator tidak ditemukan', 'ACTUATOR_NOT_FOUND');
    await db('actuators').where({ id: a.id }).update(request.body);
    await logActivity(request, { action: 'actuator.update', entity: 'actuator', entity_id: a.id, description: `Mengubah aktuator ${a.name}`, greenhouse_id: a.greenhouse_id });
    return actuatorDto(await db('actuators').where({ id: a.id }).first());
  });

  app.delete('/actuators/:id', { onRequest: rw, schema: { tags, security, summary: 'Hapus aktuator', params: idParam } }, async (request, reply) => {
    const scope = ghScope(request);
    const q = db('actuators').join('devices', 'devices.id', 'actuators.device_id').where('actuators.id', request.params.id);
    if (scope) q.andWhere('devices.greenhouse_id', scope);
    const a = await q.select('actuators.*', 'devices.greenhouse_id as greenhouse_id').first();
    if (!a) throw httpError(404, 'Aktuator tidak ditemukan', 'ACTUATOR_NOT_FOUND');
    await db('actuators').where({ id: a.id }).delete();
    await logActivity(request, { action: 'actuator.delete', entity: 'actuator', entity_id: a.id, description: `Menghapus aktuator ${a.name}`, greenhouse_id: a.greenhouse_id });
    return reply.code(204).send();
  });
}
