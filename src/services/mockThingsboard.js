// Mode simulasi: dipakai saat THINGSBOARD_MOCK=true supaya frontend bisa dikembangkan tanpa ThingsBoard/Raspberry Pi.
import { env } from '../config/env.js';
import { DEVICE_STATUS_KEYS } from '../config/metrics.js';

const reverse = Object.fromEntries(Object.entries(env.tb.keys).map(([metric, key]) => [key, metric]));
const round = (v, d = 2) => Math.round(v * 10 ** d) / 10 ** d;
const DAY = 86_400_000;

function valueFor(key, ts) {
  const metric = reverse[key];
  const h = ts / 3_600_000;
  const ec = 1.8 + 0.25 * Math.sin(h * 0.9) + 0.03 * Math.sin(h * 13);
  switch (metric) {
    case 'ph': return round(6.0 + 0.35 * Math.sin(h * 1.3) + 0.05 * Math.sin(h * 17));
    case 'ec': return round(ec);
    case 'tds': return Math.round(ec * env.tdsFactor);
    case 'water_temp': return round(25 + 2 * Math.sin((ts / DAY) * 2 * Math.PI) + 0.2 * Math.sin(h * 9), 1);
    case 'air_temp': return round(28 + 4 * Math.sin((ts / DAY) * 2 * Math.PI) + 0.3 * Math.sin(h * 11), 1);
    case 'humidity': return Math.round(68 + 10 * Math.sin((ts / DAY) * 2 * Math.PI + 1) + 2 * Math.sin(h * 7));
    case 'waterflow': return round(2.5 + 0.3 * Math.sin(h * 5));
    // tank_level sengaja tidak disimulasikan: service_1.py belum punya sensor level tangki
    default: return null;
  }
}

export const mockTb = {
  async ping() {
    return { name: 'Perangkat simulasi', type: 'default' };
  },

  async getLatest(_id, keys) {
    const ts = Date.now();
    const out = {};
    for (const k of keys) {
      if (DEVICE_STATUS_KEYS.includes(k)) {
        out[k] = { ts, value: k === 'pump_a' };
        continue;
      }
      if (k === 'sensor_online') {
        out[k] = { ts, value: true };
        continue;
      }
      const v = valueFor(k, ts);
      if (v !== null) out[k] = { ts, value: v };
    }
    return out;
  },

  async getHistory(_id, keys, { startTs, endTs, interval, limit = 1000 }) {
    const span = Math.max(1, endTs - startTs);
    const step = Math.max(interval || 60_000, Math.ceil(span / limit));
    const out = {};
    for (const k of keys) {
      const points = [];
      for (let ts = startTs - (startTs % step) + step; ts <= endTs && points.length < limit; ts += step) {
        const v = valueFor(k, ts);
        if (v !== null) points.push({ ts, value: v });
      }
      out[k] = points;
    }
    return out;
  },

  async getAttributes(_id, _keys, scope = 'SERVER_SCOPE') {
    if (scope === 'CLIENT_SCOPE') {
      return {
        ec_mode: 'all', ec: 2.5, ph_down: 5.6, ph_up: 7.5, fan_air_temp_min: 20, fan_air_temp_max: 32, fan_humidity: 80,
        peristaltic_pump_duration: 60, peristaltic_pump_period: 1, waterflow: 0, dap: [], start_dap: '2026-01-01 07:00:00',
        is_active: true, mode: 'manual', config_errors: {},
      };
    }
    return { active: true, lastActivityTime: Date.now() };
  },

  async sendRpc(_id, method, params) {
    return { ok: true, mock: true, method, params };
  },

  async setSharedAttributes(_id, attrs) {
    return { mock: true, attrs };
  },
};
