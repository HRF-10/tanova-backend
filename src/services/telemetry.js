import { env } from '../config/env.js';
import { DEVICE_STATUS_KEYS, METRICS, METRIC_NAMES, metricStatus } from '../config/metrics.js';
import { memo } from '../lib/cache.js';
import { tbFor } from './thingsboard.js';

const round = (v, d) => (v === null || v === undefined ? null : Math.round(v * 10 ** d) / 10 ** d);

export function emptyMetrics() {
  const out = {};
  for (const name of METRIC_NAMES) {
    const m = METRICS[name];
    out[name] = { label: m.label, unit: m.unit, value: null, status: 'unknown', ts: null, derived: false, stale: false };
  }
  return out;
}

// Data terkini satu perangkat: nilai metrik + status koneksi.
export function getLatestMetrics(device) {
  if (!device.tb_device_id) {
    return Promise.resolve({ online: false, last_seen: null, sensor_online: null, device_mode: null, actuator_status: {}, metrics: emptyMetrics() });
  }
  return memo(`latest:${device.id}`, 3000, async () => {
    const keys = [...METRIC_NAMES.map((n) => METRICS[n].tbKey), ...DEVICE_STATUS_KEYS, 'sensor_online', 'mode', 'system_status', 'wifi_connected', 'mqtt_connected', 'esp_ready'];
    const tb = tbFor(device);
    const [latest, attrs] = await Promise.all([
      tb.getLatest(device.tb_device_id, keys),
      tb.getAttributes(device.tb_device_id).catch(() => ({})),
    ]);

    const metrics = emptyMetrics();
    let newest = 0;
    for (const name of METRIC_NAMES) {
      const p = latest[METRICS[name].tbKey];
      if (!p || typeof p.value !== 'number' || !Number.isFinite(p.value)) continue;
      metrics[name].value = round(p.value, METRICS[name].decimals);
      metrics[name].ts = new Date(p.ts).toISOString();
      newest = Math.max(newest, p.ts);
    }
    // Nilai basi: sensor dilaporkan offline, atau data terakhir sudah lama. Dikosongkan supaya dashboard tidak menampilkan
    // angka lama sebagai angka terkini dan peringatan tidak terus terpicu dari data lama.
    const sensorOffline = latest.sensor_online?.value === false;
    for (const name of METRIC_NAMES) {
      const m = metrics[name];
      if (m.value === null) continue;
      if (sensorOffline || Date.now() - Date.parse(m.ts) > env.staleSeconds * 1000) {
        m.value = null;
        m.stale = true;
      }
    }
    // EC dan TDS saling menurunkan jika salah satunya tidak dikirim perangkat
    if (metrics.tds.value === null && metrics.ec.value !== null) {
      metrics.tds.value = round(metrics.ec.value * env.tdsFactor, 0);
      metrics.tds.ts = metrics.ec.ts;
      metrics.tds.derived = true;
    } else if (metrics.ec.value === null && metrics.tds.value !== null) {
      metrics.ec.value = round(metrics.tds.value / env.tdsFactor, 2);
      metrics.ec.ts = metrics.tds.ts;
      metrics.ec.derived = true;
    }
    for (const name of METRIC_NAMES) metrics[name].status = metricStatus(name, metrics[name].value);

    const telemetryNewest = Math.max(0, ...Object.values(latest).map((p) => Number(p?.ts) || 0));
    const lastActivity = Number(attrs.lastActivityTime) || telemetryNewest || newest || null;
    // Status relay nyata dari perangkat (dosis berwaktu mati sendiri, jadi data ini lebih akurat daripada database)
    const actuator_status = {};
    for (const key of DEVICE_STATUS_KEYS) if (typeof latest[key]?.value === 'boolean') actuator_status[key] = latest[key].value;

    return {
      online: attrs.active === true,
      last_seen: lastActivity ? new Date(lastActivity).toISOString() : null,
      // sensor_online=false berarti ESP sensor berhenti mengirim data ke Raspberry Pi (bukan Raspberry Pi yang offline)
      sensor_online: typeof latest.sensor_online?.value === 'boolean' ? latest.sensor_online.value : null,
      system_status: typeof latest.system_status?.value === 'string' ? latest.system_status.value : null,
      wifi_connected: typeof latest.wifi_connected?.value === 'boolean' ? latest.wifi_connected.value : null,
      mqtt_connected: typeof latest.mqtt_connected?.value === 'boolean' ? latest.mqtt_connected.value : null,
      esp_ready: typeof latest.esp_ready?.value === 'boolean' ? latest.esp_ready.value : null,
      device_mode: ['auto', 'manual'].includes(latest.mode?.value) ? latest.mode.value : null,
      actuator_status,
      metrics,
    };
  });
}

// Timpa state aktuator di database dengan status relay terbaru dari perangkat (bila tersedia).
export async function withLiveActuatorState(device, actuators) {
  let live = {};
  try {
    live = (await getLatestMetrics(device)).actuator_status;
  } catch {
    /* ThingsBoard tidak terjangkau: pakai state terakhir di database */
  }
  return actuators.map((a) => (a.control_key in live ? { ...a, state: live[a.control_key] ? 'on' : 'off', state_source: 'device' } : { ...a, state_source: 'database' }));
}

// Riwayat telemetri: [{ ts, ph, ec, ... }] urut waktu naik.
export async function getHistory(device, { metrics, startTs, endTs, interval, agg, limit }) {
  if (!device.tb_device_id) return [];
  const wanted = metrics.filter((m) => METRICS[m]);
  const keys = wanted.map((m) => METRICS[m].tbKey);
  const raw = await tbFor(device).getHistory(device.tb_device_id, keys, { startTs, endTs, interval, agg, limit });

  const byTs = new Map();
  for (const m of wanted) {
    for (const p of raw[METRICS[m].tbKey] || []) {
      if (!byTs.has(p.ts)) byTs.set(p.ts, { ts: p.ts });
      byTs.get(p.ts)[m] = round(p.value, METRICS[m].decimals);
    }
  }
  return [...byTs.values()].sort((a, b) => a.ts - b.ts);
}

// Status koneksi satu perangkat untuk badge di dashboard.
//   not_configured : Device ID / akun ThingsBoard belum diisi
//   error          : backend gagal ke ThingsBoard (alamat, akun, atau Device ID salah)
//   offline        : Raspberry Pi tidak terhubung ke ThingsBoard
//   sensor_offline : Raspberry Pi terhubung, tetapi sensor tidak mengirim data
//   connected      : semuanya terhubung
export async function getConnectionStatus(device) {
  const base = {
    online: false, sensor_online: null, last_seen: null,
    system_status: null, wifi_connected: null, mqtt_connected: null, esp_ready: null,
  };
  if (!device.tb_device_id) return { status: 'not_configured', message: 'Device ID ThingsBoard belum diisi', ...base };
  try {
    const t = await getLatestMetrics(device);
    const info = {
      online: t.online, sensor_online: t.sensor_online, last_seen: t.last_seen,
      system_status: t.system_status, wifi_connected: t.wifi_connected,
      mqtt_connected: t.mqtt_connected, esp_ready: t.esp_ready,
    };
    if (!t.online) return { status: 'offline', message: 'Perangkat tidak aktif di ThingsBoard', ...info };
    if (t.wifi_connected === false || t.mqtt_connected === false || t.system_status === 'disconnected') {
      return { status: 'connection_degraded', message: 'Perangkat terhubung sebagian; periksa Wi-Fi/MQTT', ...info };
    }
    if (t.sensor_online === false) return { status: 'sensor_offline', message: 'Terhubung ke ThingsBoard, tetapi sensor tidak mengirim data', ...info };
    return { status: 'connected', message: 'Terhubung', ...info };
  } catch (err) {
    if (err.code === 'NO_TB_CREDENTIALS') return { status: 'not_configured', message: 'Email dan password ThingsBoard belum diisi', ...base };
    return { status: 'error', message: err.message, ...base };
  }
}
