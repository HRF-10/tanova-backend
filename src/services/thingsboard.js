import { createHash } from 'node:crypto';
import { env } from '../config/env.js';
import { decrypt } from '../lib/crypto.js';
import { httpError } from '../lib/errors.js';
import { mockTb } from './mockThingsboard.js';

// Sesi login dibagi per akun ThingsBoard (url + username + hash password), jadi setiap pengguna/perangkat
// memakai akunnya sendiri dan permintaan paralel berbagi satu proses login.
const sessions = new Map();

const sessionKey = (c) => `${c.url}|${c.username}|${createHash('sha256').update(c.password).digest('hex').slice(0, 16)}`;

function decodeExp(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
    return payload.exp * 1000;
  } catch {
    return Date.now() + 10 * 60_000;
  }
}

const numeric = (list) =>
  (list || [])
    .map((p) => ({ ts: Number(p.ts), value: Number(p.value) }))
    .filter((p) => Number.isFinite(p.value));

// Nilai terbaru dari ThingsBoard berupa teks: ubah ke boolean / angka bila cocok.
function parseValue(v) {
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return v === undefined || v === null ? null : v;
}

function makeClient(conn) {
  const base = conn.url.replace(/\/$/, '');
  const key = sessionKey(conn);

  async function login() {
    let res;
    try {
      res = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: conn.username, password: conn.password }),
        signal: AbortSignal.timeout(env.tb.timeoutMs),
      });
    } catch {
      throw httpError(502, `Tidak dapat terhubung ke ThingsBoard (${base})`, 'TB_UNREACHABLE');
    }
    if (res.status === 401) throw httpError(401, 'Email atau password ThingsBoard salah', 'TB_AUTH_FAILED');
    if (!res.ok) throw httpError(502, `Login ThingsBoard gagal (${res.status})`, 'TB_AUTH_FAILED');
    const data = await res.json();
    return { token: data.token, exp: decodeExp(data.token) };
  }

  async function getToken() {
    const s = sessions.get(key) || {};
    // perbarui 60 detik sebelum kedaluwarsa
    if (s.token && Date.now() <= s.exp - 60_000) return s.token;
    if (!s.inflight) {
      s.inflight = login().then(
        (r) => { sessions.set(key, { ...r }); return r.token; },
        (err) => { sessions.delete(key); throw err; },
      );
      sessions.set(key, s);
    }
    return s.inflight;
  }

  async function call(path, { method = 'GET', query, body, timeoutMs = env.tb.timeoutMs } = {}, attempt = 0) {
    const token = await getToken();
    const url = new URL(base + path);
    for (const [k, v] of Object.entries(query || {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }
    let res;
    try {
      res = await fetch(url, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-Authorization': `Bearer ${token}` },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      throw httpError(502, 'Tidak dapat terhubung ke ThingsBoard', 'TB_UNREACHABLE');
    }
    if (res.status === 401 && attempt === 0) {
      sessions.delete(key);
      return call(path, { method, query, body, timeoutMs }, 1);
    }
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      const status = res.status === 408 || res.status === 504 ? 504 : res.status === 404 ? 404 : 502;
      const hint = res.status === 408 ? ' (perangkat tidak merespons / offline)' : res.status === 404 ? ' (device ID tidak ditemukan)' : '';
      throw httpError(status, `ThingsBoard ${res.status}${hint}: ${text.slice(0, 200)}`, 'TB_ERROR');
    }
    const type = res.headers.get('content-type') || '';
    return type.includes('json') ? res.json() : res.text();
  }

  return {
    // Login baru + baca data device. Dipakai tombol "Tes koneksi" di GUI.
    async ping(deviceId) {
      sessions.delete(key);
      await getToken();
      return call(`/api/device/${deviceId}`);
    },

    // -> { key: { ts, value } } (value bisa angka, boolean, atau teks)
    async getLatest(deviceId, keys) {
      const data = await call(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`, { query: { keys: keys.join(',') } });
      const out = {};
      for (const k of keys) {
        const p = data?.[k]?.[0];
        const value = p ? parseValue(p.value) : null;
        if (value !== null) out[k] = { ts: Number(p.ts), value };
      }
      return out;
    },

    // -> { key: [{ ts, value }] } urut naik berdasarkan waktu
    async getHistory(deviceId, keys, { startTs, endTs, interval, agg, limit = 1000 }) {
      const aggregate = agg && agg !== 'NONE' ? agg : 'NONE';
      const data = await call(`/api/plugins/telemetry/DEVICE/${deviceId}/values/timeseries`, {
        query: {
          keys: keys.join(','), startTs, endTs, limit,
          orderBy: 'DESC', // ambil data terbaru dulu bila melebihi limit
          agg: aggregate,
          interval: aggregate === 'NONE' ? undefined : interval,
        },
        timeoutMs: 20_000,
      });
      const out = {};
      for (const k of keys) out[k] = numeric(data?.[k]).sort((a, b) => a.ts - b.ts);
      return out;
    },

    // scope: SERVER_SCOPE (status koneksi), CLIENT_SCOPE (pengaturan yang berlaku di perangkat), SHARED_SCOPE
    async getAttributes(deviceId, keys = ['active', 'lastActivityTime'], scope = 'SERVER_SCOPE') {
      const data = await call(`/api/plugins/telemetry/DEVICE/${deviceId}/values/attributes/${scope}`, { query: { keys: keys.join(',') } });
      const out = {};
      for (const a of data || []) out[a.key] = a.value === 'true' ? true : a.value === 'false' ? false : a.value;
      return out;
    },

    // RPC ke perangkat. Raspberry Pi menerimanya di topik MQTT v1/devices/me/rpc/request/+
    async sendRpc(deviceId, method, params = {}) {
      const mode = env.tb.rpcMode;
      return call(`/api/rpc/${mode}/${deviceId}`, {
        method: 'POST',
        body: { method, params },
        // Raspberry Pi memproses perintah berurutan dan tiap publish ke relay menunggu 2 detik
        timeoutMs: mode === 'twoway' ? 25_000 : env.tb.timeoutMs,
        query: mode === 'twoway' ? { timeout: 20_000 } : undefined,
      });
    },

    // Shared attributes: tersimpan di ThingsBoard dan dikirim ke perangkat saat terhubung (topik v1/devices/me/attributes)
    async setSharedAttributes(deviceId, attrs) {
      return call(`/api/plugins/telemetry/DEVICE/${deviceId}/attributes/SHARED_SCOPE`, { method: 'POST', body: attrs });
    },
  };
}

// Klien ThingsBoard untuk satu perangkat, memakai akun yang diisi pengguna di GUI.
// Perangkat tanpa akun sendiri memakai TB_USERNAME/TB_PASSWORD dari .env bila ada (cadangan untuk pengembangan).
export function tbFor(device) {
  if (env.tb.mock) return mockTb;
  const url = device.tb_url || env.tb.url;
  const username = device.tb_username || env.tb.username;
  let password = '';
  if (device.tb_password_enc) password = decrypt(device.tb_password_enc);
  else if (!device.tb_username) password = env.tb.password;
  if (!username || !password) {
    throw httpError(422, 'Akun ThingsBoard untuk perangkat ini belum diisi. Isi email dan password ThingsBoard di pengaturan koneksi perangkat.', 'NO_TB_CREDENTIALS');
  }
  return makeClient({ url, username, password });
}

// Dipakai saat kredensial diganti agar sesi lama tidak ikut terpakai.
export function forgetSessions() {
  sessions.clear();
}
