// =====================================================================================
// TANOVA GROVE 1 — DEVICE SIMULATOR
//
// Simulator ini menggantikan perangkat fisik untuk demo FE + BE:
// - MQTT ThingsBoard: telemetri, client/shared attributes, RPC request/response
// - Sensor: pH, EC, suhu air, suhu udara, kelembapan, waterflow
// - Aktuator: 4 pompa dosis, 2 pompa sirkulasi, kipas, pemanas
// - Mode manual/otomatis, konfigurasi EC/pH/DAP, interlock dan timer pompa dosis
//
// Catatan: nilai sensor dan efek aktuator adalah data simulasi, bukan hasil pengukuran.
// Analisis foto memakai Gemini di backend; simulator menyediakan perintah camera untuk menguji jalur upload backend.
// Profil kalibrasi simulator dimulai identity (status siap demo), lalu RPC calibrate
// menerapkan koreksi offset/scale ke nilai sensor simulasi.
//
// Jalankan: npm run simulator
// Perintah terminal: help
// =====================================================================================
import mqtt from 'mqtt';
import fs from 'node:fs';
import dotenv from 'dotenv';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CALIBRATION_KEYS, normalizeCalibrationSensor, calculateCalibrationProfile, composeCalibrationProfiles, calibratedReading } from './calibration.js';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const HOST = process.env.THINGSBOARD_HOST || 'mqtt.thingsboard.cloud';
const TLS = bool(process.env.THINGSBOARD_TLS);
const PORT = Number(process.env.THINGSBOARD_PORT) || (TLS ? 8883 : 1883);
const TOKEN = process.env.THINGSBOARD_TOKEN;
const INTERVAL = Math.max(2, Number(process.env.THINGSBOARD_INTERVAL) || 10);
const MANUAL_MAX_DURATION = Math.max(1, Number(process.env.MANUAL_MAX_DURATION) || 300);
const AUTO_TICK_MS = Math.max(1000, Number(process.env.SIM_AUTO_TICK_MS) || 3000);
const PHYSICS_TICK_MS = Math.max(500, Number(process.env.SIM_PHYSICS_TICK_MS) || 2000);
const FAST_DEMO = process.env.SIM_FAST_DEMO === undefined ? true : bool(process.env.SIM_FAST_DEMO);
const CAMERA_BACKEND_URL = (process.env.CAMERA_BACKEND_URL || 'http://localhost:3000/api/v1/ai/analyze').replace(/\/$/, '');
const CAMERA_API_KEY = process.env.CAMERA_API_KEY || '';
const CAMERA_DEVICE_ID = process.env.CAMERA_DEVICE_ID || ''; 

if (!TOKEN) {
  console.error('THINGSBOARD_TOKEN belum diisi. Salin simulator/.env.example menjadi simulator/.env lalu isi access token device.');
  process.exit(1);
}

// Key ini mengikuti src/config/contract.js dan docs/KONTRAK-SERVICE.md.
const SENSOR_KEYS = ['ph', 'ec', 'temp_water', 'temp_air', 'humidity', 'waterflow'];
const ACTUATOR_KEYS = ['pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down', 'pump_a', 'pump_b', 'fan', 'heater'];
const DOSING_KEYS = ['pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down'];
const CONFIG_KEYS = [
  'ec_mode', 'ec', 'ph_down', 'ph_up', 'fan_air_temp_min', 'fan_air_temp_max',
  'fan_humidity', 'peristaltic_pump_duration', 'peristaltic_pump_period',
  'waterflow', 'dap', 'start_dap',
];
const REMOTE_KEYS = ['mode', ...CONFIG_KEYS];
const SPEC = {
  mode: ['enum', ['auto', 'manual']],
  ec_mode: ['enum', ['all', 'single']],
  ec: ['num', 0, 20],
  ph_down: ['num', 0, 14],
  ph_up: ['num', 0, 14],
  fan_air_temp_min: ['num', -20, 100],
  fan_air_temp_max: ['num', -20, 100],
  fan_humidity: ['num', 0, 100],
  peristaltic_pump_duration: ['num', 1, 600],
  peristaltic_pump_period: ['num', 0, 1440],
  waterflow: ['num', 0, 1000],
  dap: ['list', 0, 20, 400],
  start_dap: ['datetime'],
};
const TOPIC = {
  telemetry: 'v1/devices/me/telemetry',
  attributes: 'v1/devices/me/attributes',
  attributesRequest: 'v1/devices/me/attributes/request/1',
  attributesResponse: 'v1/devices/me/attributes/response/',
  rpcRequest: 'v1/devices/me/rpc/request/',
  rpcResponse: 'v1/devices/me/rpc/response/',
};
const nowWib = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const log = (message) => console.log(`[${new Date().toLocaleTimeString('id-ID', { hour12: false })}] ${message}`);

let mode = process.env.SIM_START_MODE === 'auto' ? 'auto' : 'manual';
let sensorOnline = true;
let configErrors = {};
// Profil awal identity: sensor tampil sudah terkalibrasi saat demo dimulai.
// Nilai awal tidak dikoreksi (scale=1, offset=0); kalibrasi ulang dari FE mengubah profil ini.
const calibrationState = Object.fromEntries(CALIBRATION_KEYS.map((key) => [key, {
  calibrated: true, calibrated_at: Date.now(), scale: 1, offset: 0,
  reference_values: { method: 'demo-default', points: [] },
}]));
const CALIBRATION_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'calibration-state.json');
try {
  if (fs.existsSync(CALIBRATION_FILE)) {
    const saved = JSON.parse(fs.readFileSync(CALIBRATION_FILE, 'utf8'));
    for (const key of CALIBRATION_KEYS) {
      const item = saved?.[key];
      if (item && item.calibrated === true && Number.isFinite(item.scale) && Number.isFinite(item.offset)) {
        calibrationState[key] = { ...calibrationState[key], ...item };
      }
    }
    log('Profil kalibrasi sebelumnya dimuat dari calibration-state.json');
  }
} catch (error) {
  log(`Profil kalibrasi tersimpan tidak dapat dibaca; memakai profil demo awal: ${error.message}`);
}

function persistCalibrationState() {
  fs.writeFileSync(CALIBRATION_FILE, JSON.stringify(calibrationState, null, 2));
}
let wifiSsid = '';
let wifiPasswordConfigured = false;
let lastPumpSwitchAt = 0;
let nextDoseAt = 0;
let wakeTimer = null;
let connected = false;
let stopping = false;

const config = {
  ec_mode: 'all',
  ec: 2.0,
  ph_down: 5.6,
  ph_up: 6.5,
  fan_air_temp_min: 20,
  fan_air_temp_max: 32,
  fan_humidity: 80,
  peristaltic_pump_duration: 8,
  peristaltic_pump_period: 1,
  waterflow: 0,
  dap: [],
  start_dap: nowWib(),
  is_active: true,
};

const values = {
  ph: 6.1,
  ec: 1.85,
  temp_water: 25.2,
  temp_air: 29.1,
  humidity: 68,
  waterflow: 2.5,
};
const sensorTargets = { ...values };
const sensorOverrides = new Set();
const actuator = Object.fromEntries(ACTUATOR_KEYS.map((key) => [key, false]));
actuator.pump_a = true;
const doseTimers = new Map();

function validateConfigValue(key, value) {
  const spec = SPEC[key];
  if (!spec) return 'key tidak dikenal';
  if (spec[0] === 'enum') {
    return typeof value === 'string' && spec[1].includes(value)
      ? null : `harus salah satu dari ${spec[1].join(', ')}`;
  }
  if (spec[0] === 'num') {
    return isNum(value) && value >= spec[1] && value <= spec[2]
      ? null : `harus angka ${spec[1]} sampai ${spec[2]}`;
  }
  if (spec[0] === 'list') {
    if (!Array.isArray(value) || value.length > spec[3]) return `harus daftar angka (maksimum ${spec[3]} nilai)`;
    return value.every((item) => isNum(item) && item >= spec[1] && item <= spec[2])
      ? null : `setiap nilai harus angka ${spec[1]} sampai ${spec[2]}`;
  }
  return typeof value === 'string'
    && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)
    && !Number.isNaN(Date.parse(value.replace(' ', 'T')))
    ? null : 'format harus YYYY-MM-DD HH:MM:SS';
}

function cancelDose(key) {
  const timer = doseTimers.get(key);
  if (timer) clearTimeout(timer);
  doseTimers.delete(key);
}

function stopNonMainActuators() {
  for (const key of DOSING_KEYS) cancelDose(key);
  for (const key of [...DOSING_KEYS, 'fan', 'heater']) actuator[key] = false;
}

function wake() {
  if (!connected || stopping) return;
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => {
    publishTelemetry();
    publishClientAttributes();
  }, 150);
}

function publish(topic, payload) {
  if (!connected || stopping) return;
  client.publish(topic, JSON.stringify(payload), { qos: 1 }, (err) => {
    if (err) log(`Gagal publish ${topic}: ${err.message}`);
  });
}

function sensorReadings() {
  return Object.fromEntries(SENSOR_KEYS.map((key) => {
    const calibrationKey = normalizeCalibrationSensor(key);
    const profile = calibrationState[calibrationKey] || { scale: 1, offset: 0 };
    return [key, calibratedReading(values[key], profile)];
  }));
}

function buildTelemetry() {
  const telemetry = {};
  if (sensorOnline) {
    const decimals = { ph: 2, ec: 2, temp_water: 1, temp_air: 1, humidity: 0, waterflow: 2 };
    const readings = sensorReadings();
    for (const key of SENSOR_KEYS) telemetry[key] = round(readings[key], decimals[key]);
  }
  for (const key of ACTUATOR_KEYS) telemetry[key] = Boolean(actuator[key]);
  for (const [key, state] of Object.entries(calibrationState)) {
    telemetry[`calibrated_${key}`] = Boolean(state.calibrated);
  }
  telemetry.sensor_online = sensorOnline;
  telemetry.mode = mode;
  return telemetry;
}

function buildClientAttributes() {
  return {
    ...Object.fromEntries(CONFIG_KEYS.map((key) => [key, config[key]])),
    is_active: Boolean(config.is_active),
    mode,
    config_errors: { ...configErrors },
  };
}

function publishTelemetry() {
  if (connected) publish(TOPIC.telemetry, { ts: Date.now(), values: buildTelemetry() });
}

function publishClientAttributes() {
  if (connected) publish(TOPIC.attributes, buildClientAttributes());
}

function setMode(nextMode) {
  if (!['auto', 'manual'].includes(nextMode)) return { ok: false, error: 'mode harus auto atau manual' };
  if (mode === nextMode) return { ok: true, mode, unchanged: true };
  mode = nextMode;
  log(`Mode sistem berubah menjadi ${mode}`);
  if (mode === 'manual') stopNonMainActuators();
  else if (!actuator.pump_a && !actuator.pump_b) actuator.pump_a = true;
  wake();
  return { ok: true, mode };
}

function applyConfig(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    return { valid: {}, rejected: {}, unknown: [] };
  }
  const valid = {};
  const rejected = {};
  const unknown = Object.keys(updates).filter((key) => !REMOTE_KEYS.includes(key) && key !== 'is_active');
  for (const [key, value] of Object.entries(updates)) {
    if (key === 'is_active') {
      if (typeof value === 'boolean') valid[key] = value;
      else rejected[key] = 'harus boolean';
      continue;
    }
    if (!SPEC[key]) continue;
    const reason = validateConfigValue(key, value);
    if (reason) rejected[key] = reason;
    else valid[key] = value;
  }

  const merged = { ...config, ...valid };
  const orderRules = [
    ['ph_down', 'ph_up', 'ph_down harus lebih kecil dari ph_up'],
    ['fan_air_temp_min', 'fan_air_temp_max', 'fan_air_temp_min harus lebih kecil dari fan_air_temp_max'],
  ];
  for (const [lower, upper, message] of orderRules) {
    if ((lower in valid || upper in valid) && !(merged[lower] < merged[upper])) {
      for (const key of [lower, upper]) {
        if (key in valid) {
          rejected[key] = message;
          delete valid[key];
        }
      }
    }
  }

  const previousMode = mode;
  const requestedMode = valid.mode;
  delete valid.mode;
  Object.assign(config, valid);
  if (requestedMode) setMode(requestedMode);

  configErrors = Object.fromEntries(Object.entries(configErrors).filter(([key]) => !(key in updates)));
  Object.assign(configErrors, rejected);
  if (Object.keys(valid).length) log(`Konfigurasi diterapkan: ${JSON.stringify(valid)}`);
  if (Object.keys(rejected).length) log(`Konfigurasi ditolak: ${JSON.stringify(rejected)}`);
  if (previousMode !== mode || Object.keys(valid).length || Object.keys(rejected).length) wake();
  return { valid, rejected, unknown };
}

function startDose(key, seconds, onComplete) {
  if (!DOSING_KEYS.includes(key)) return { ok: false, error: 'aktuator bukan pompa dosis' };
  actuator[key] = true;
  cancelDose(key);
  const timer = setTimeout(() => {
    doseTimers.delete(key);
    actuator[key] = false;
    log(`${key} selesai setelah ${seconds} detik`);
    wake();
    if (onComplete && mode === 'auto') onComplete();
  }, seconds * 1000);
  doseTimers.set(key, timer);
  wake();
  return { ok: true, actuator: key, state: true, duration: seconds };
}

function setActuator(params) {
  if (mode !== 'manual') return { ok: false, error: 'Mode otomatis aktif; ubah ke manual terlebih dahulu' };
  const { actuator: key, state } = params;
  if (!ACTUATOR_KEYS.includes(key)) return { ok: false, error: `actuator tidak dikenal: ${key}` };
  if (typeof state !== 'boolean') return { ok: false, error: 'state harus boolean' };

  if (DOSING_KEYS.includes(key)) {
    if (!state) {
      cancelDose(key);
      actuator[key] = false;
      wake();
      return { ok: true, actuator: key, state: false };
    }
    const busy = DOSING_KEYS.filter((other) => other !== key && actuator[other]);
    if (busy.length) return { ok: false, error: `pompa dosis lain sedang aktif: ${busy.join(', ')}` };
    const duration = params.duration ?? config.peristaltic_pump_duration;
    if (!isNum(duration) || duration < 1 || duration > MANUAL_MAX_DURATION) {
      return { ok: false, error: `duration harus angka 1 sampai ${MANUAL_MAX_DURATION} detik` };
    }
    return startDose(key, duration);
  }

  if (key === 'pump_a' || key === 'pump_b') {
    if (!state) {
      actuator[key] = false;
    } else {
      actuator.pump_a = key === 'pump_a';
      actuator.pump_b = key === 'pump_b';
    }
    wake();
    return { ok: true, actuator: key, state, pump_a: actuator.pump_a, pump_b: actuator.pump_b };
  }

  actuator[key] = state;
  wake();
  return { ok: true, actuator: key, state };
}

function targetEc() {
  if (config.ec_mode === 'single' && config.dap.length) {
    const start = Date.parse(config.start_dap.replace(' ', 'T') + '+07:00');
    const day = Math.floor((Date.now() - start) / 86_400_000);
    return config.dap[Math.min(Math.max(day, 0), config.dap.length - 1)];
  }
  return config.ec;
}

function switchMainPump() {
  const next = actuator.pump_a ? 'pump_b' : 'pump_a';
  actuator.pump_a = next === 'pump_a';
  actuator.pump_b = next === 'pump_b';
  lastPumpSwitchAt = Date.now();
  log(`[otomatis] pompa utama berpindah ke ${next}`);
  wake();
}

function autoControl() {
  if (mode !== 'auto' || !sensorOnline || !config.is_active) return;
  const reading = sensorReadings();
  if (!actuator.pump_a && !actuator.pump_b) {
    actuator.pump_a = true;
    wake();
  }

  const want = (key, state) => {
    if (actuator[key] !== state) {
      actuator[key] = state;
      log(`[otomatis] ${key} ${state ? 'ON' : 'OFF'}`);
      wake();
    }
  };
  want('fan', reading.humidity >= config.fan_humidity || reading.temp_air >= config.fan_air_temp_max);
  want('heater', reading.temp_air <= config.fan_air_temp_min);

  // Jika aliran berada pada/di bawah ambang konfigurasi, pindah ke pompa utama cadangan.
  if (config.waterflow > 0 && reading.waterflow <= config.waterflow && Date.now() - lastPumpSwitchAt > 15000) {
    switchMainPump();
  }

  if (DOSING_KEYS.some((key) => actuator[key]) || Date.now() < nextDoseAt) return;
  const duration = Math.min(config.peristaltic_pump_duration, MANUAL_MAX_DURATION);
  const cooldownSec = FAST_DEMO ? Math.min(config.peristaltic_pump_period * 60, 20) : config.peristaltic_pump_period * 60;
  let selected = null;
  let afterFirst = null;

  if (reading.ph < config.ph_down) selected = 'pump_ph_up';
  else if (reading.ph > config.ph_up) selected = 'pump_ph_down';
  else if (reading.ec < targetEc()) {
    selected = 'pump_ec_a';
    afterFirst = () => startDose('pump_ec_b', duration);
  }
  if (!selected) return;

  log(`[otomatis] dosis ${selected} selama ${duration} detik`);
  nextDoseAt = Date.now() + duration * 1000 * (afterFirst ? 2 : 1) + cooldownSec * 1000;
  startDose(selected, duration, afterFirst);
}

function physicsTick() {
  if (!sensorOnline) return;
  const noise = (amplitude) => (Math.random() - 0.5) * amplitude;
  const approach = (key, factor, amplitude) => {
    if (sensorOverrides.has(key)) return;
    values[key] += (sensorTargets[key] - values[key]) * factor + noise(amplitude);
  };

  approach('ph', 0.02, 0.015);
  approach('ec', 0.015, 0.008);
  approach('temp_water', 0.02, 0.04);
  approach('temp_air', 0.02, 0.08);
  approach('humidity', 0.02, 0.25);

  if (!sensorOverrides.has('ph')) {
    if (actuator.pump_ph_up) values.ph += 0.035;
    if (actuator.pump_ph_down) values.ph -= 0.035;
  }
  if (!sensorOverrides.has('ec') && (actuator.pump_ec_a || actuator.pump_ec_b)) values.ec += 0.018;
  if (!sensorOverrides.has('temp_air')) {
    if (actuator.heater) values.temp_air += 0.10;
    if (actuator.fan) values.temp_air -= 0.08;
  }
  if (!sensorOverrides.has('humidity') && actuator.fan) values.humidity -= 0.20;

  if (!sensorOverrides.has('waterflow')) {
    values.waterflow = actuator.pump_a || actuator.pump_b ? 2.5 + noise(0.2) : 0;
  }
  values.ph = Math.min(14, Math.max(0, values.ph));
  values.ec = Math.min(20, Math.max(0, values.ec));
  values.humidity = Math.min(100, Math.max(0, values.humidity));
  values.temp_water = Math.min(80, Math.max(-10, values.temp_water));
  values.temp_air = Math.min(100, Math.max(-20, values.temp_air));
}

function setSensorOnline(next) {
  if (sensorOnline === next) return;
  sensorOnline = next;
  log(`Sensor ${sensorOnline ? 'online' : 'offline'}`);
  if (!sensorOnline && mode === 'auto') {
    stopNonMainActuators();
    actuator.pump_a = true;
    actuator.pump_b = false;
  }
  wake();
}

function getState() {
  return {
    ok: true,
    device: 'Tanova Grove 1 (simulator)',
    mode,
    sensor_online: sensorOnline,
    status: { ...actuator },
    values: sensorOnline ? sensorReadings() : {},
    calibration: Object.fromEntries(Object.entries(calibrationState).map(([key, value]) => [key, { ...value }])),
    config: buildClientAttributes(),
    wifi: { configured: Boolean(wifiSsid && wifiPasswordConfigured), ssid: wifiSsid || null },
  };
}

function handleRpc(payload) {
  try {
    const method = payload?.method;
    let params = payload?.params;
    if (typeof params === 'string') params = JSON.parse(params);
    if (params === undefined || params === null) params = {};
    if (typeof params !== 'object' || Array.isArray(params)) return { ok: false, error: 'params harus objek JSON' };

    if (method === 'setActuator') return setActuator(params);
    if (method === 'setMode') return setMode(params.mode);
    if (method === 'setConfig') {
      const result = applyConfig(params);
      const ok = Object.keys(result.rejected).length === 0
        && (Object.keys(result.valid).length > 0 || Object.keys(result.unknown).length === 0);
      return { ok, applied: result.valid, rejected: result.rejected, unknown: result.unknown,
        ...(!ok ? { error: 'sebagian atau seluruh konfigurasi ditolak' } : {}) };
    }
    if (method === 'getState') return getState();
    if (method === 'calibrate') {
      const sensor = normalizeCalibrationSensor(params.sensor || params.key);
      if (!Object.hasOwn(calibrationState, sensor)) {
        return { ok: false, simulated: true, error: `sensor kalibrasi tidak dikenal: ${sensor || '(kosong)'}` };
      }
      const profile = calculateCalibrationProfile(params.reference_values);
      if (profile.error) return { ok: false, simulated: true, error: profile.error };
      const calibratedAt = Date.now();
      const effective = composeCalibrationProfiles(calibrationState[sensor], profile);
      calibrationState[sensor] = {
        calibrated: true,
        calibrated_at: calibratedAt,
        scale: effective.scale,
        offset: effective.offset,
        reference_values: { points: profile.points },
      };
      persistCalibrationState();
      log(`[simulator] kalibrasi ${sensor} diterapkan dan disimpan: scale=${round(effective.scale, 6)}, offset=${round(effective.offset, 6)}`);
      wake();
      return {
        ok: true, simulated: true, sensor, calibrated: true,
        calibrated_at: calibratedAt,
        profile: { scale: effective.scale, offset: effective.offset },
        message: 'Profil koreksi sensor simulasi berhasil diperbarui. Ini simulasi kalibrasi, bukan kalibrasi fisik.',
      };
    }
    return { ok: false, error: `method '${method}' tidak dikenal` };
  } catch (error) {
    return { ok: false, error: `galat simulator: ${error.message}` };
  }
}

function applySharedAttributes(payload) {
  const shared = payload?.shared && typeof payload.shared === 'object' ? payload.shared : payload;
  if (!shared || typeof shared !== 'object' || Array.isArray(shared)) return;
  const updates = {};
  for (const key of REMOTE_KEYS) {
    if (key in shared) updates[key] = shared[key];
  }
  if (Object.keys(updates).length) applyConfig(updates);

  if (typeof shared.wifi_ssid === 'string') {
    wifiSsid = shared.wifi_ssid;
    log(`Konfigurasi Wi-Fi diterima (SSID: ${wifiSsid || '(kosong)'}).`);
  }
  if (typeof shared.wifi_password === 'string') {
    wifiPasswordConfigured = shared.wifi_password.length > 0;
    // Password sengaja tidak dicetak ke terminal dan tidak dipublish sebagai client attribute.
    log('Password Wi-Fi diterima oleh simulator (nilai disembunyikan).');
  }
}

function publishSharedAttributeRequest() {
  publish(T.attributesRequest, { sharedKeys: [...REMOTE_KEYS, 'wifi_ssid', 'wifi_password'].join(',') });
}

const client = mqtt.connect({
  protocol: TLS ? 'mqtts' : 'mqtt',
  host: HOST,
  port: PORT,
  username: TOKEN,
  clientId: `tanova-grove1-sim-${Math.random().toString(16).slice(2, 8)}`,
  keepalive: 60,
  reconnectPeriod: 5000,
  connectTimeout: 20_000,
});

client.on('connect', () => {
  connected = true;
  log(`Terhubung ke ThingsBoard ${HOST}:${PORT}${TLS ? ' (TLS)' : ''}`);
  client.subscribe([TOPIC.rpcRequest + '+', TOPIC.attributes, TOPIC.attributesResponse + '+'], { qos: 1 });
  publishSharedAttributeRequest();
  publishClientAttributes();
  publishTelemetry();
});
client.on('reconnect', () => log('Mencoba menyambung kembali ke ThingsBoard...'));
client.on('close', () => {
  if (connected) log('Koneksi ThingsBoard terputus.');
  connected = false;
});
client.on('error', (error) => {
  log(`Galat MQTT: ${error.message}${/not authorized|Bad username/i.test(error.message) ? ' (periksa THINGSBOARD_TOKEN)' : ''}`);
});
client.on('message', (topic, buffer) => {
  let payload;
  try {
    payload = JSON.parse(buffer.toString() || '{}');
  } catch {
    log(`Payload JSON tidak valid dari ${topic}`);
    return;
  }

  if (topic.startsWith(TOPIC.rpcRequest)) {
    const requestId = topic.slice(TOPIC.rpcRequest.length);
    const result = handleRpc(payload);
    log(`RPC ${requestId} ${payload.method || '(tanpa method)'}: ${result.ok ? 'OK' : result.error || JSON.stringify(result.rejected || {})}`);
    publish(TOPIC.rpcResponse + requestId, result);
  } else if (topic.startsWith(TOPIC.attributesResponse) || topic === TOPIC.attributes) {
    applySharedAttributes(payload);
  }
});

const physicsTimer = setInterval(physicsTick, PHYSICS_TICK_MS);
const autoTimer = setInterval(autoControl, AUTO_TICK_MS);
const telemetryTimer = setInterval(publishTelemetry, INTERVAL * 1000);
const attributesTimer = setInterval(publishClientAttributes, 60_000);

async function sendCameraImage(filePath) {
  if (!CAMERA_API_KEY) {
    console.log('CAMERA_API_KEY belum diisi di simulator/.env.');
    return;
  }
  if (!CAMERA_DEVICE_ID) {
    console.log('CAMERA_DEVICE_ID belum diisi di simulator/.env (ID device backend TANOVA).');
    return;
  }
  const absolutePath = path.resolve(filePath.replace(/^['"]|['"]$/g, ''));
  if (!fs.existsSync(absolutePath) || !fs.statSync(absolutePath).isFile()) {
    console.log(`File gambar tidak ditemukan: ${absolutePath}`);
    return;
  }
  const ext = path.extname(absolutePath).toLowerCase();
  const mime = ({ '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' })[ext];
  if (!mime) {
    console.log('Format foto harus JPG, PNG, atau WebP.');
    return;
  }
  const bytes = fs.readFileSync(absolutePath);
  const form = new FormData();
  form.append('image', new Blob([bytes], { type: mime }), path.basename(absolutePath));
  if (CAMERA_DEVICE_ID) form.append('device_id', CAMERA_DEVICE_ID);
  log(`Mengirim foto ke backend TANOVA untuk analisis Gemini: ${path.basename(absolutePath)}`);
  try {
    const response = await fetch(CAMERA_BACKEND_URL, {
      method: 'POST',
      headers: { 'x-api-key': CAMERA_API_KEY },
      body: form,
      signal: AbortSignal.timeout(90000),
    });
    const body = await response.json().catch(() => ({}));
    console.log(JSON.stringify({ http_status: response.status, ...body }, null, 2));
  } catch (error) {
    console.log(`Upload kamera gagal: ${error.message}`);
  }
}

const HELP = `Perintah simulator Tanova Grove 1:
  status                         lihat mode, sensor, konfigurasi, dan relay
  set <sensor> <angka>           ubah target sensor (ph, ec, temp_water, temp_air, humidity, waterflow)
  sensor on|off                  hidupkan/matikan data sensor
  mode auto|manual               ganti mode perangkat
  actuator <key> on|off [detik]  uji aktuator saat mode manual
  config <JSON>                  ubah konfigurasi seperti RPC setConfig
  calibrate <sensor> <measured> <reference>  demo kalibrasi satu titik
  camera <path-gambar>           kirim foto uji ke backend untuk dianalisis Gemini
  help                           tampilkan bantuan
  quit                           hentikan simulator

Contoh:
  set ph 4.8
  set waterflow 0.1
  actuator pump_ph_up on 5
  config {"ec":2.2,"ph_down":5.5,"ph_up":6.5}
  camera ./contoh-daun.jpg
  mode auto`;

function printStatus() {
  console.log(JSON.stringify({
    device: 'Tanova Grove 1 (simulator)',
    connected_to_thingsboard: connected,
    mode,
    sensor_online: sensorOnline,
    sensors: sensorOnline ? Object.fromEntries(SENSOR_KEYS.map((key) => [key, round(sensorReadings()[key])])) : 'offline',
    calibration: calibrationState,
    actuators: actuator,
    config: buildClientAttributes(),
    wifi: { configured: Boolean(wifiSsid && wifiPasswordConfigured), ssid: wifiSsid || null },
  }, null, 2));
}

function parseValue(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  try { return JSON.parse(raw); } catch { return raw; }
}

async function shutdown() {
  if (stopping) return;
  stopping = true;
  clearInterval(physicsTimer);
  clearInterval(autoTimer);
  clearInterval(telemetryTimer);
  clearInterval(attributesTimer);
  clearTimeout(wakeTimer);
  for (const key of DOSING_KEYS) cancelDose(key);
  log('Simulator dihentikan.');
  client.end(true, () => process.exit(0));
  setTimeout(() => process.exit(0), 1500).unref();
}

console.log(`Tanova Grove 1 simulator aktif. Mode awal: ${mode}. ThingsBoard: ${HOST}:${PORT}. Ketik "help".`);
const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
terminal.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  const firstSpace = trimmed.indexOf(' ');
  const command = firstSpace < 0 ? trimmed : trimmed.slice(0, firstSpace);
  const rest = firstSpace < 0 ? '' : trimmed.slice(firstSpace + 1).trim();

  if (command === 'help') {
    console.log(HELP);
  } else if (command === 'status') {
    printStatus();
  } else if (command === 'sensor') {
    if (rest === 'on' || rest === 'off') setSensorOnline(rest === 'on');
    else console.log('Gunakan: sensor on|off');
  } else if (command === 'mode') {
    const result = setMode(rest);
    if (!result.ok) console.log(result.error);
  } else if (command === 'auto' || command === 'manual') {
    const result = setMode(command);
    if (!result.ok) console.log(result.error);
  } else if (command === 'set') {
    const [key, raw] = rest.split(/\s+/, 2);
    if (!SENSOR_KEYS.includes(key) || raw === undefined || !Number.isFinite(Number(raw))) {
      console.log(`Sensor yang bisa diubah: ${SENSOR_KEYS.join(', ')}`);
    } else {
      const value = Number(raw);
      values[key] = value;
      sensorTargets[key] = value;
      sensorOverrides.add(key);
      log(`Nilai simulasi ${key} diatur ke ${value}`);
      wake();
    }
  } else if (command === 'calibration') {
    const [action, sensorRaw] = rest.split(/\s+/);
    if (action !== 'reset') {
      console.log('Gunakan: calibration reset [sensor|all]');
    } else {
      const selected = sensorRaw && sensorRaw !== 'all'
        ? [normalizeCalibrationSensor(sensorRaw)]
        : [...CALIBRATION_KEYS];
      const unknown = selected.find((key) => !Object.hasOwn(calibrationState, key));
      if (unknown) {
        console.log(`Sensor kalibrasi tidak dikenal: ${unknown}`);
      } else {
        for (const key of selected) {
          calibrationState[key] = {
            calibrated: true, calibrated_at: Date.now(), scale: 1, offset: 0,
            reference_values: { method: 'demo-default', points: [] },
          };
        }
        persistCalibrationState();
        log(`Profil kalibrasi direset: ${selected.join(', ')}`);
        wake();
      }
    }
  } else if (command === 'calibrate') {
    const [sensorRaw, measuredRaw, referenceRaw] = rest.split(/\s+/);
    const sensor = normalizeCalibrationSensor(sensorRaw);
    const measured = Number(measuredRaw);
    const reference = Number(referenceRaw);
    if (!Object.hasOwn(calibrationState, sensor) || !Number.isFinite(measured) || !Number.isFinite(reference)) {
      console.log('Gunakan: calibrate <ph|ec|water_temp|temp_air|humidity|waterflow> <nilai_terukur> <nilai_referensi>');
    } else {
      const result = handleRpc({ method: 'calibrate', params: { sensor, reference_values: { points: [{ measured, reference }] } } });
      console.log(JSON.stringify(result, null, 2));
    }
  } else if (command === 'actuator') {
    const [key, state, seconds] = rest.split(/\s+/);
    if (!ACTUATOR_KEYS.includes(key) || !['on', 'off'].includes(state)) {
      console.log(`Gunakan: actuator <${ACTUATOR_KEYS.join('|')}> on|off [detik]`);
    } else {
      const result = setActuator({ actuator: key, state: state === 'on', ...(seconds ? { duration: Number(seconds) } : {}) });
      console.log(JSON.stringify(result));
    }
  } else if (command === 'camera') {
    if (!rest) console.log('Gunakan: camera <path-gambar>');
    else void sendCameraImage(rest);
  } else if (command === 'config') {
    try {
      const parsed = JSON.parse(rest);
      const result = applyConfig(parsed);
      console.log(JSON.stringify({ applied: result.valid, rejected: result.rejected, unknown: result.unknown }, null, 2));
    } catch (error) {
      console.log(`JSON konfigurasi tidak valid: ${error.message}`);
    }
  } else if (command === 'quit' || command === 'exit') {
    shutdown();
  } else {
    console.log('Perintah tidak dikenal. Ketik "help".');
  }
});

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
