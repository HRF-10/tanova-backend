// =====================================================================================
// THINGSBOARD TIRUAN (opsional, hanya untuk uji lokal tanpa internet)
//
// Menyediakan REST API dan MQTT broker mini dengan perilaku ThingsBoard yang dipakai backend dan service:
//   MQTT (port 1883) : telemetri, atribut klien, permintaan atribut shared, RPC request/response
//   REST (port 8099) : login, telemetri terbaru/riwayat, atribut, RPC oneway/twoway
// Hanya satu device. Bukan pengganti ThingsBoard sungguhan.
//
// Jalankan:  npm run fake-tb
// Lalu:      backend  -> THINGSBOARD_MOCK=false, TB_URL=http://localhost:8099
//            GUI      -> email tenant@thingsboard.org, password tenant, Device ID 11111111-2222-3333-4444-555555555555
//            simulator -> THINGSBOARD_HOST=localhost, THINGSBOARD_TOKEN=SIMTOKEN
// =====================================================================================
import http from 'node:http';
import net from 'node:net';
import { Aedes } from 'aedes';

const DEVICE_ID = process.env.FAKE_TB_DEVICE_ID || '11111111-2222-3333-4444-555555555555';
const DEVICE_TOKEN = process.env.FAKE_TB_TOKEN || 'SIMTOKEN';
const USER = process.env.FAKE_TB_USER || 'tenant@thingsboard.org';
const PASS = process.env.FAKE_TB_PASSWORD || 'tenant';
const MQTT_PORT = Number(process.env.FAKE_TB_MQTT_PORT) || 1883;
const HTTP_PORT = Number(process.env.FAKE_TB_HTTP_PORT) || 8099;

const aedes = await Aedes.createBroker();
const history = []; // { ts, values }
const latest = new Map(); // key -> { ts, value }
const clientAttrs = {};
const sharedAttrs = {};
const pending = new Map();
let rpcSeq = 0;
let connectedClients = 0;
let lastActivity = null;
const log = (m) => console.log(`[fake-tb ${new Date().toLocaleTimeString('id-ID', { hour12: false })}] ${m}`);

// ---------------------------------------------------------------- MQTT
aedes.authenticate = (_client, username, _password, cb) => {
  if (String(username) === DEVICE_TOKEN) return cb(null, true);
  const err = new Error('Bad username or password');
  err.returnCode = 4;
  return cb(err, false);
};
aedes.on('clientReady', () => { connectedClients += 1; lastActivity = Date.now(); log('device terhubung'); });
aedes.on('clientDisconnect', () => { connectedClients = Math.max(0, connectedClients - 1); log('device terputus'); });

// Pesan dari device ditangani di sini. Topik atribut dipindah ke topik internal supaya tidak dipantulkan
// kembali ke device itu sendiri (ThingsBoard asli juga tidak memantulkannya).
aedes.authorizePublish = (client, packet, cb) => {
  if (!client || !packet.topic.startsWith('v1/devices/me/')) return cb(null);
  lastActivity = Date.now();
  const text = packet.payload.toString() || '{}';
  let data;
  try { data = JSON.parse(text); } catch { data = {}; }
  const t = packet.topic;
  if (t === 'v1/devices/me/telemetry') {
    for (const item of Array.isArray(data) ? data : [data]) {
      const ts = item.ts ?? Date.now();
      const values = item.values ?? item;
      history.push({ ts, values });
      if (history.length > 5000) history.shift();
      for (const [k, v] of Object.entries(values)) latest.set(k, { ts, value: v });
    }
  } else if (t === 'v1/devices/me/attributes') {
    Object.assign(clientAttrs, data);
    packet.topic = '__internal/device-attributes';
  } else if (t.startsWith('v1/devices/me/attributes/request/')) {
    const id = t.split('/').pop();
    const wanted = String(data.sharedKeys || '').split(',').filter(Boolean);
    const shared = Object.fromEntries(Object.entries(sharedAttrs).filter(([k]) => !wanted.length || wanted.includes(k)));
    aedes.publish({ cmd: 'publish', qos: 0, retain: false, dup: false, topic: `v1/devices/me/attributes/response/${id}`, payload: Buffer.from(JSON.stringify({ shared })) }, () => {});
  } else if (t.startsWith('v1/devices/me/rpc/response/')) {
    const id = t.split('/').pop();
    const waiter = pending.get(id);
    if (waiter) { pending.delete(id); clearTimeout(waiter.timer); waiter.resolve(data); }
  }
  return cb(null);
};

net.createServer(aedes.handle).listen(MQTT_PORT, () => log(`MQTT broker di port ${MQTT_PORT} (token device: ${DEVICE_TOKEN})`));

const toDevice = (topic, payload) =>
  aedes.publish({ cmd: 'publish', qos: 0, retain: false, dup: false, topic, payload: Buffer.from(JSON.stringify(payload)) }, () => {});

// ---------------------------------------------------------------- REST
const jwt = () => `x.${Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 9000 })).toString('base64url')}.y`;
const validTokens = new Set();

const server = http.createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', async () => {
    const url = new URL(req.url, 'http://x');
    const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
    let json = null;
    try { json = body ? JSON.parse(body) : null; } catch { return send(400, { message: 'JSON tidak valid' }); }
    const p = url.pathname;

    if (p === '/api/auth/login' && req.method === 'POST') {
      if (json?.username === USER && json?.password === PASS) {
        const token = jwt();
        validTokens.add(token);
        return send(200, { token, refreshToken: 'r' });
      }
      return send(401, { message: 'Invalid username or password' });
    }
    const bearer = String(req.headers['x-authorization'] || '').replace('Bearer ', '');
    if (!validTokens.has(bearer)) return send(401, { message: 'Authentication failed' });

    const m = /^\/api\/(?:device|plugins\/telemetry\/DEVICE|rpc\/(?:oneway|twoway))\/([^/]+)/.exec(p);
    if (m && m[1] !== DEVICE_ID) return send(404, { message: 'Device tidak ditemukan' });

    if (p === `/api/device/${DEVICE_ID}`) return send(200, { name: 'Perangkat Simulasi', type: 'default' });

    if (p.endsWith('/values/timeseries')) {
      const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
      const out = {};
      if (url.searchParams.get('startTs')) {
        const start = Number(url.searchParams.get('startTs'));
        const end = Number(url.searchParams.get('endTs'));
        const limit = Number(url.searchParams.get('limit')) || 100;
        for (const k of keys) {
          const rows = history.filter((h) => h.ts >= start && h.ts <= end && k in h.values).map((h) => ({ ts: h.ts, value: String(h.values[k]) }));
          rows.sort((a, b) => b.ts - a.ts);
          out[k] = rows.slice(0, limit);
        }
      } else {
        for (const k of keys) if (latest.has(k)) out[k] = [{ ts: latest.get(k).ts, value: String(latest.get(k).value) }];
      }
      return send(200, out);
    }

    const attr = /\/values\/attributes\/(SERVER_SCOPE|CLIENT_SCOPE|SHARED_SCOPE)$/.exec(p);
    if (attr) {
      const source = attr[1] === 'CLIENT_SCOPE' ? clientAttrs : attr[1] === 'SHARED_SCOPE' ? sharedAttrs : { active: connectedClients > 0, lastActivityTime: lastActivity };
      const keys = (url.searchParams.get('keys') || '').split(',').filter(Boolean);
      return send(200, Object.entries(source).filter(([k]) => !keys.length || keys.includes(k)).map(([key, value]) => ({ key, value, lastUpdateTs: Date.now() })));
    }

    if (/\/attributes\/SHARED_SCOPE$/.test(p) && req.method === 'POST') {
      Object.assign(sharedAttrs, json);
      toDevice('v1/devices/me/attributes', json);
      log(`shared attribute -> device: ${JSON.stringify(json)}`);
      return send(200, {});
    }

    const rpc = /^\/api\/rpc\/(oneway|twoway)\//.exec(p);
    if (rpc && req.method === 'POST') {
      if (connectedClients < 1) return send(408, { message: 'Device is offline' });
      const id = String(++rpcSeq);
      log(`RPC ${rpc[1]} ${json?.method} ${JSON.stringify(json?.params)}`);
      toDevice(`v1/devices/me/rpc/request/${id}`, json);
      if (rpc[1] === 'oneway') return send(200, {});
      const timeout = Number(url.searchParams.get('timeout')) || 10000;
      const answer = await new Promise((resolve) => {
        const timer = setTimeout(() => { pending.delete(id); resolve(null); }, timeout);
        pending.set(id, { resolve, timer });
      });
      return answer === null ? send(408, { message: 'Request Timeout' }) : send(200, answer);
    }
    return send(404, { message: 'Tidak ditemukan' });
  });
});
server.listen(HTTP_PORT, () => log(`REST di http://localhost:${HTTP_PORT} (login ${USER} / ${PASS}, Device ID ${DEVICE_ID})`));
