import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';
import { deviceDto, pickDevice } from '../../lib/devices.js';
import { ghScope } from '../../lib/scope.js';
import { calibrationOverview } from '../../services/calibration.js';
import { emptyMetrics, getConnectionStatus, getLatestMetrics, withLiveActuatorState } from '../../services/telemetry.js';
import { httpError } from '../../lib/errors.js';

const tags = ['Dashboard'];
const security = [{ bearerAuth: [] }];

export default async function dashboardRoutes(app) {
  const ro = [app.authenticate];

  async function snapshot(device, greenhouseId) {
    const [sensors, actuators, unread] = await Promise.all([
      db('sensors').where({ device_id: device.id }),
      db('actuators').where({ device_id: device.id }).orderBy('created_at'),
      db('alert_events').where({ greenhouse_id: greenhouseId }).whereNull('read_at').count({ n: '*' }).first(),
    ]);
    let telemetry;
    let telemetry_error = null;
    try {
      telemetry = await getLatestMetrics(device);
    } catch (err) {
      telemetry = { online: false, last_seen: null, sensor_online: null, device_mode: null, actuator_status: {}, metrics: emptyMetrics() };
      telemetry_error = err.message;
    }
    const calibrations = await calibrationOverview(sensors);
    return {
      device: deviceDto(device),
      connection: await getConnectionStatus(device),
      mode: telemetry.device_mode || device.mode, // mode yang benar-benar berlaku di perangkat bila dilaporkan
      online: telemetry.online,
      sensor_online: telemetry.sensor_online,
      last_seen: telemetry.last_seen,
      metrics: telemetry.metrics,
      actuators: (await withLiveActuatorState(device, actuators)).map((a) => dto(a)),
      calibration: {
        overdue: calibrations.filter((c) => c.status === 'overdue').length,
        due_soon: calibrations.filter((c) => c.status === 'due_soon').length,
        never: calibrations.filter((c) => c.status === 'never').length,
        items: calibrations,
      },
      unread_alerts: Number(unread?.n || 0),
      telemetry_error,
      server_time: new Date().toISOString(),
    };
  }

  app.get('/dashboard/overview', {
    onRequest: ro,
    schema: {
      tags, security,
      summary: 'Dashboard utama: metrik terkini (pH, EC/TDS, suhu air, level tangki), mode, aktuator, kalibrasi',
      querystring: { type: 'object', properties: { device_id: { type: 'string' }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request) => {
    const device = await pickDevice(request.query.device_id, ghScope(request));
    if (!device) return { device: null, metrics: emptyMetrics(), actuators: [], message: 'Belum ada perangkat terdaftar' };
    return snapshot(device, device.greenhouse_id);
  });

  // Server-Sent Events untuk tampilan real-time. EventSource tidak bisa mengirim header,
  // jadi token boleh dikirim lewat query ?token=<access_token>.
  app.get('/dashboard/stream', {
    onRequest: async (request) => {
      if (!request.headers.authorization && request.query?.token) {
        request.headers.authorization = `Bearer ${request.query.token}`;
      }
      await app.authenticate(request);
    },
    schema: {
      tags, security,
      summary: 'Stream real-time metrik (SSE), event "metrics" setiap beberapa detik',
      querystring: { type: 'object', properties: { device_id: { type: 'string' }, token: { type: 'string' }, interval: { type: 'integer', minimum: 2, maximum: 60, default: 5 }, greenhouse_id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    const device = await pickDevice(request.query.device_id, ghScope(request));
    if (!device) throw httpError(404, 'Belum ada perangkat terdaftar', 'DEVICE_NOT_FOUND');

    reply.hijack();
    const raw = reply.raw;
    raw.writeHead(200, {
      ...reply.getHeaders(),
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const push = async () => {
      try {
        const data = await getLatestMetrics(device);
        raw.write(`event: metrics\ndata: ${JSON.stringify({ device_id: device.id, mode: device.mode, ...data, server_time: new Date().toISOString() })}\n\n`);
      } catch (err) {
        raw.write(`event: error\ndata: ${JSON.stringify({ message: err.message })}\n\n`);
      }
    };
    await push();
    const timer = setInterval(push, (request.query.interval || 5) * 1000);
    const ping = setInterval(() => raw.write(': ping\n\n'), 25_000);
    request.raw.on('close', () => {
      clearInterval(timer);
      clearInterval(ping);
    });
  });
}
