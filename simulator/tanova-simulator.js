// =====================================================================================
// SIMULATOR SERVICE TANOVA
//
// Berperan sebagai Raspberry Pi (service_1.py): terhubung ke ThingsBoard lewat MQTT memakai access token,
// mengirim telemetri berkala, menerima RPC dan atribut dari backend, lalu membalas seperti service asli.
// Semua perilaku mengikuti kontrak di src/config/contract.js dan docs/KONTRAK-SERVICE.md.
// Bukan pengganti service asli: tidak ada sensor, Redis, mosquitto, atau relay sungguhan.
//
// Jalankan:  npm run simulator      (isi simulator/.env dulu, lihat simulator/.env.example)
// Perintah di terminal saat berjalan: ketik "help"
// =====================================================================================
import mqtt from 'mqtt';
import dotenv from 'dotenv';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), '.env') });

const bool = (v) => ['1', 'true', 'yes', 'on'].includes(String(v ?? '').trim().toLowerCase());
const HOST = process.env.THINGSBOARD_HOST || 'mqtt.thingsboard.cloud';
const TLS = bool(process.env.THINGSBOARD_TLS);
const PORT = Number(process.env.THINGSBOARD_PORT) || (TLS ? 8883 : 1883);
const TOKEN = process.env.THINGSBOARD_TOKEN;
const INTERVAL = Math.max(1, Number(process.env.THINGSBOARD_INTERVAL) || 10);
const MANUAL_MAX_DURATION = Math.max(1, Number(process.env.MANUAL_MAX_DURATION) || 300);

if (!TOKEN) {
  console.error('THINGSBOARD_TOKEN belum diisi. Salin simulator/.env.example menjadi simulator/.env lalu isi access token device.');
  process.exit(1);
}

// ------------------------------------------------------------------ kontrak
const VALUE_KEYS = ['ec', 'ph', 'temp_water', 'temp_air', 'humidity', 'waterflow'];
const STATUS_KEYS = ['pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down', 'pump_a', 'pump_b', 'fan', 'heater'];
const DOSING = ['pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down'];
const CONFIG_KEYS = ['ec_mode', 'ec', 'ph_down', 'ph_up', 'fan_air_temp_min', 'fan_air_temp_max', 'fan_humidity',
  'peristaltic_pump_duration', 'peristaltic_pump_period', 'waterflow', 'dap', 'start_dap', 'is_active'];
// Sama dengan _REMOTE_SPEC di service_1.py
const SPEC = {
  mode: ['enum', ['auto', 'manual']],
  ec_mode: ['enum', ['all', 'single']],
  ec: ['num', 0, 20], ph_down: ['num', 0, 14], ph_up: ['num', 0, 14],
  fan_air_temp_min: ['num', -20, 100], fan_air_temp_max: ['num', -20, 100], fan_humidity: ['num', 0, 100],
  peristaltic_pump_duration: ['num', 1, 600], peristaltic_pump_period: ['num', 0, 1440], waterflow: ['num', 0, 1000],
  dap: ['list', 0, 20, 400], start_dap: ['datetime'],
};
const REMOTE_KEYS = Object.keys(SPEC);
const ORDER_RULES = [
  ['ph_down', 'ph_up', 'ph_down harus lebih kecil dari ph_up'],
  ['fan_air_temp_min', 'fan_air_temp_max', 'fan_air_temp_min harus lebih kecil dari fan_air_temp_max'],
];
const T = {
  telemetry: 'v1/devices/me/telemetry',
  attrs: 'v1/devices/me/attributes',
  attrsReq: 'v1/devices/me/attributes/request/1',
  attrsResp: 'v1/devices/me/attributes/response/',
  rpcReq: 'v1/devices/me/rpc/request/',
  rpcRes: 'v1/devices/me/rpc/response/',
};

// ------------------------------------------------------------------ keadaan
const nowWib = () => new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Jakarta' });
let autoMode = process.env.SIM_START_MODE === 'auto'; // service asli mulai dari "auto"; simulator "manual" agar mudah diuji
let sensorOnline = true;
let configErrors = {};
// Nilai bawaan dibuat wajar untuk iklim tropis (bawaan service asli: fan_air_temp_min 30, fan_humidity 30)
const config = {
  ec_mode: 'all', ec: 2.0, ph_down: 5.6, ph_up: 7.5, fan_air_temp_min: 20, fan_air_temp_max: 32, fan_humidity: 80,
  peristaltic_pump_duration: 20, peristaltic_pump_period: 1, waterflow: 0, dap: [], start_dap: nowWib(), is_active: true,
};
const values = { ec: 1.9, ph: 6.3, temp_water: 25, temp_air: 29, humidity: 70, waterflow: 2.5 };
const base = { ...values };
const status = Object.fromEntries(STATUS_KEYS.map((k) => [k, false]));
status.pump_a = true;
const timers = new Map(); // pompa dosis -> timeout
let nextDoseAt = 0;

const log = (msg) => console.log(`[${new Date().toLocaleTimeString('id-ID', { hour12: false })}] ${msg}`);
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const round = (v, d) => Math.round(v * 10 ** d) / 10 ** d;

// ------------------------------------------------------------------ validasi (sama dengan service)
function validateRemote(key, value) {
  const spec = SPEC[key];
  if (spec[0] === 'enum') return typeof value === 'string' && spec[1].includes(value) ? null : `harus salah satu dari ${spec[1].join(', ')}`;
  if (spec[0] === 'num') return isNum(value) && value >= spec[1] && value <= spec[2] ? null : `harus angka ${spec[1]} sampai ${spec[2]}`;
  if (spec[0] === 'list') {
    if (!Array.isArray(value) || value.length > spec[3]) return `harus daftar angka (maksimum ${spec[3]} nilai)`;
    return value.every((v) => isNum(v) && v >= spec[1] && v <= spec[2]) ? null : `setiap nilai harus angka ${spec[1]} sampai ${spec[2]}`;
  }
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) && !Number.isNaN(Date.parse(value.replace(' ', 'T')))
    ? null : 'format harus YYYY-MM-DD HH:MM:SS';
}

function applyRemoteConfig(updates) {
  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) return { valid: {}, rejected: {} };
  const candidates = Object.fromEntries(REMOTE_KEYS.filter((k) => k in updates).map((k) => [k, updates[k]]));
  if (!Object.keys(candidates).length) return { valid: {}, rejected: {} };
  const valid = {};
  const rejected = {};
  for (const [k, v] of Object.entries(candidates)) {
    const reason = validateRemote(k, v);
    if (reason) rejected[k] = reason;
    else valid[k] = v;
  }
  const merged = { ...config, ...valid };
  for (const [low, high, text] of ORDER_RULES) {
    if ((low in valid || high in valid) && !(isNum(merged[low]) && isNum(merged[high]) && merged[low] < merged[high])) {
      for (const k of [low, high]) if (k in valid) { rejected[k] = text; delete valid[k]; }
    }
  }
  const previousMode = autoMode ? 'auto' : 'manual';
  const { mode, ...configUpdates } = valid;
  Object.assign(config, configUpdates);
  configErrors = Object.fromEntries(Object.entries(configErrors).filter(([k]) => !(k in candidates)));
  Object.assign(configErrors, rejected);
  if (Object.keys(valid).length) log(`Pengaturan dari website diterapkan: ${JSON.stringify(valid)}`);
  if (Object.keys(rejected).length) log(`Pengaturan dari website DITOLAK: ${JSON.stringify(rejected)}`);
  if (mode && mode !== previousMode) switchMode(mode);
  wake();
  return { valid, rejected };
}

function switchMode(newMode) {
  log(`Mode sistem: ${newMode}`);
  if (newMode === 'auto') {
    if (!(status.pump_a || status.pump_b)) status.pump_a = true;
    autoMode = true;
    return;
  }
  autoMode = false;
  for (const t of timers.values()) clearTimeout(t);
  timers.clear();
  for (const k of [...DOSING, 'fan', 'heater']) status[k] = false;
}

// ------------------------------------------------------------------ RPC (sama dengan service)
const fail = (error) => ({ ok: false, error });

function startDose(name, seconds, then) {
  status[name] = true;
  clearTimeout(timers.get(name));
  timers.set(name, setTimeout(() => {
    timers.delete(name);
    status[name] = false;
    log(`${name} selesai`);
    wake();
    if (then && autoMode) then();
  }, seconds * 1000));
  wake();
}

function rpcSetActuator(params) {
  if (autoMode) return fail('Mode otomatis aktif; ubah ke manual terlebih dahulu');
  const { actuator: name, state } = params;
  const known = [...DOSING, 'fan', 'heater', 'pump_a', 'pump_b'];
  if (!known.includes(name)) return fail(`actuator tidak dikenal; pilih: ${known.join(', ')}`);
  if (typeof state !== 'boolean') return fail('state harus true atau false');

  if (DOSING.includes(name)) {
    if (!state) {
      clearTimeout(timers.get(name));
      timers.delete(name);
      status[name] = false;
      wake();
      return { ok: true, actuator: name, state: false };
    }
    const busy = DOSING.filter((n) => n !== name && status[n]);
    if (busy.length) return fail(`pompa dosis lain sedang aktif: ${busy.join(', ')}`);
    const duration = params.duration ?? config.peristaltic_pump_duration;
    if (!isNum(duration) || duration < 1 || duration > MANUAL_MAX_DURATION) return fail(`duration harus angka 1 sampai ${MANUAL_MAX_DURATION} detik`);
    startDose(name, duration);
    return { ok: true, actuator: name, state: true, duration };
  }
  if (name === 'fan' || name === 'heater') {
    status[name] = state;
    wake();
    return { ok: true, actuator: name, state };
  }
  const toA = name === 'pump_a';
  const isOn = toA ? status.pump_a : status.pump_b;
  if (!state) {
    if (!isOn) return { ok: true, actuator: name, state: false, unchanged: true };
    status[name] = false;
    wake();
    return { ok: true, actuator: name, state: false };
  }
  if (isOn) return { ok: true, actuator: name, state: true, unchanged: true };
  status.pump_a = toA;
  status.pump_b = !toA;
  wake();
  return { ok: true, actuator: name, state: true };
}

function handleRpc(payload) {
  try {
    const { method } = payload;
    let { params } = payload;
    if (typeof params === 'string') params = JSON.parse(params);
    if (params === undefined || params === null) params = {};
    if (typeof params !== 'object' || Array.isArray(params)) return fail('params harus objek JSON');
    if (method === 'setMode') {
      const { rejected } = applyRemoteConfig({ mode: params.mode });
      return rejected.mode ? fail(rejected.mode) : { ok: true, mode: autoMode ? 'auto' : 'manual' };
    }
    if (method === 'setConfig') {
      const unknown = Object.keys(params).filter((k) => !REMOTE_KEYS.includes(k));
      const { valid, rejected } = applyRemoteConfig(params);
      const result = { ok: Object.keys(valid).length > 0 && !Object.keys(rejected).length, applied: valid, rejected, unknown };
      if (!Object.keys(valid).length && !Object.keys(rejected).length) result.error = 'tidak ada pengaturan yang dikenal';
      return result;
    }
    if (method === 'setActuator') return rpcSetActuator(params);
    if (method === 'getState') return { ok: true, mode: autoMode ? 'auto' : 'manual', sensor_online: sensorOnline, status, values, config: buildAttributes() };
    return fail(`method '${method}' tidak dikenal`);
  } catch (err) {
    return fail(`galat di perangkat: ${err.message}`);
  }
}

// ------------------------------------------------------------------ simulasi sensor dan kendali otomatis
function physics() {
  if (!sensorOnline) return;
  const noise = (a) => (Math.random() - 0.5) * a;
  const v = values;
  v.ph += (base.ph - v.ph) * 0.01 + noise(0.02) + (status.pump_ph_up ? 0.05 : 0) - (status.pump_ph_down ? 0.05 : 0);
  v.ec += (base.ec - v.ec) * 0.005 + noise(0.01) + (status.pump_ec_a || status.pump_ec_b ? 0.03 : 0);
  v.temp_water += (base.temp_water - v.temp_water) * 0.01 + noise(0.05);
  v.temp_air += (base.temp_air - v.temp_air) * 0.01 + noise(0.1) + (status.heater ? 0.15 : 0) - (status.fan ? 0.12 : 0);
  v.humidity += (base.humidity - v.humidity) * 0.01 + noise(0.3) - (status.fan ? 0.4 : 0);
  v.waterflow = status.pump_a || status.pump_b ? 2.5 + noise(0.3) : 0;
  v.ph = Math.min(14, Math.max(0, v.ph));
  v.ec = Math.min(20, Math.max(0, v.ec));
  v.humidity = Math.min(100, Math.max(0, v.humidity));
}

function targetEc() {
  if (config.ec_mode === 'single' && config.dap.length) {
    const day = Math.floor((Date.now() - Date.parse(config.start_dap.replace(' ', 'T') + '+07:00')) / 86_400_000);
    return config.dap[Math.min(Math.max(day, 0), config.dap.length - 1)];
  }
  return config.ec;
}

// Kendali otomatis disederhanakan dari service asli: kipas, pemanas, dan satu dosis pada satu waktu
function autoControl() {
  if (!autoMode || !sensorOnline) return;
  const v = values;
  const want = (key, on) => {
    if (status[key] !== on) { status[key] = on; log(`[otomatis] ${key} ${on ? 'menyala' : 'mati'}`); wake(); }
  };
  want('fan', v.humidity >= config.fan_humidity || v.temp_air >= config.fan_air_temp_max);
  want('heater', v.temp_air <= config.fan_air_temp_min);

  if (DOSING.some((n) => status[n]) || Date.now() < nextDoseAt) return;
  const duration = config.peristaltic_pump_duration;
  const cooldown = Math.min(config.peristaltic_pump_period * 60, 20) * 1000; // dipercepat agar terlihat saat demo
  let pick = null;
  let chain;
  if (v.ph < config.ph_down) pick = 'pump_ph_up';
  else if (v.ph > config.ph_up) pick = 'pump_ph_down';
  else if (v.ec < targetEc()) { pick = 'pump_ec_a'; chain = () => startDose('pump_ec_b', duration); }
  if (!pick) return;
  log(`[otomatis] dosis ${pick} ${duration} detik`);
  nextDoseAt = Date.now() + duration * 1000 * (chain ? 2 : 1) + cooldown;
  startDose(pick, duration, chain);
}

function setSensorOnline(on) {
  if (sensorOnline === on) return;
  sensorOnline = on;
  log(`Sensor ${on ? 'online' : 'offline'}`);
  if (!on && autoMode) {
    // pengawas service asli: sensor diam saat mode otomatis -> semua relay mati kecuali pompa utama A
    for (const t of timers.values()) clearTimeout(t);
    timers.clear();
    for (const k of STATUS_KEYS) status[k] = false;
    status.pump_a = true;
  }
  wake();
}

// ------------------------------------------------------------------ MQTT
function buildTelemetry() {
  const t = {};
  if (sensorOnline) {
    const digits = { ec: 2, ph: 2, temp_water: 1, temp_air: 1, humidity: 0, waterflow: 2 };
    for (const k of VALUE_KEYS) t[k] = round(values[k], digits[k]);
  }
  for (const k of STATUS_KEYS) t[k] = Boolean(status[k]);
  t.sensor_online = sensorOnline;
  t.mode = autoMode ? 'auto' : 'manual';
  return t;
}

function buildAttributes() {
  const attrs = Object.fromEntries(CONFIG_KEYS.filter((k) => k in config).map((k) => [k, config[k]]));
  attrs.mode = autoMode ? 'auto' : 'manual';
  attrs.config_errors = { ...configErrors };
  return attrs;
}

const client = mqtt.connect({
  protocol: TLS ? 'mqtts' : 'mqtt', host: HOST, port: PORT, username: TOKEN,
  clientId: `tanova-simulator-${Math.random().toString(16).slice(2, 8)}`, keepalive: 60, reconnectPeriod: 5000,
});

let connected = false;
const sendTelemetry = () => connected && client.publish(T.telemetry, JSON.stringify({ ts: Date.now(), values: buildTelemetry() }), { qos: 1 });
const sendAttributes = () => connected && client.publish(T.attrs, JSON.stringify(buildAttributes()), { qos: 1 });
let wakeTimer = null;
function wake() { // kirim segera (digabung agar tidak membanjiri)
  clearTimeout(wakeTimer);
  wakeTimer = setTimeout(() => { sendTelemetry(); sendAttributes(); }, 200);
}

client.on('connect', () => {
  connected = true;
  log(`Terhubung ke ThingsBoard ${HOST}:${PORT}${TLS ? ' (TLS)' : ''}`);
  client.subscribe([T.rpcReq + '+', T.attrs, T.attrsResp + '+'], { qos: 1 });
  client.publish(T.attrsReq, JSON.stringify({ sharedKeys: REMOTE_KEYS.join(',') }), { qos: 1 });
  sendAttributes();
  sendTelemetry();
});
client.on('close', () => { if (connected) log('Koneksi ke ThingsBoard terputus, mencoba lagi...'); connected = false; });
client.on('error', (err) => log(`Galat MQTT: ${err.message}${/not authorized|Bad username/i.test(err.message) ? ' (periksa THINGSBOARD_TOKEN)' : ''}`));

client.on('message', (topic, buf) => {
  let payload;
  try { payload = JSON.parse(buf.toString() || '{}'); } catch { return; }
  if (topic.startsWith(T.rpcReq)) {
    const id = topic.slice(T.rpcReq.length);
    const result = handleRpc(payload);
    log(`RPC ${id} ${payload.method}: ${result.ok ? 'OK' : result.error || JSON.stringify(result.rejected)}`);
    client.publish(T.rpcRes + id, JSON.stringify(result), { qos: 1 });
  } else if (topic.startsWith(T.attrsResp)) {
    applyRemoteConfig(payload.shared || {});
  } else if (topic === T.attrs) {
    applyRemoteConfig(payload.shared || payload);
  }
});

setInterval(physics, 2000);
setInterval(autoControl, 5000);
setInterval(sendTelemetry, INTERVAL * 1000);
setInterval(sendAttributes, 60_000);

// ------------------------------------------------------------------ perintah terminal
const HELP = `Perintah:
  status                 tampilkan keadaan saat ini
  set <kunci> <nilai>    atur nilai sensor (ph, ec, temp_water, temp_air, humidity, waterflow)
                         contoh: set ph 4.8   (berguna untuk memicu peringatan)
  sensor off|on          putuskan / sambungkan sensor
  help                   bantuan ini
  quit                   keluar`;
console.log(`Simulator Tanova dimulai. Mode awal: ${autoMode ? 'auto' : 'manual'}. Ketik "help" untuk perintah.`);
readline.createInterface({ input: process.stdin }).on('line', (line) => {
  const [cmd, a, b] = line.trim().split(/\s+/);
  if (cmd === 'status') {
    console.log(JSON.stringify({ mode: autoMode ? 'auto' : 'manual', sensor_online: sensorOnline, nilai: Object.fromEntries(VALUE_KEYS.map((k) => [k, round(values[k], 2)])), aktuator_menyala: STATUS_KEYS.filter((k) => status[k]) }, null, 1));
  } else if (cmd === 'set' && VALUE_KEYS.includes(a) && Number.isFinite(Number(b))) {
    values[a] = base[a] = Number(b);
    log(`${a} diatur ke ${b}`);
    wake();
  } else if (cmd === 'sensor' && (a === 'on' || a === 'off')) {
  setSensorOnline(a === 'on');
  } else if (cmd === 'auto') {
    switchMode('auto');
    wake();
  } else if (cmd === 'manual') {
    switchMode('manual');
    wake();
  } else if (cmd === 'quit') {
    client.end(true, () => process.exit(0));
  } else if (cmd) {
    console.log(HELP);
  }
});
process.on('SIGINT', () => client.end(true, () => process.exit(0)));
