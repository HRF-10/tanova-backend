import { db } from '../db/knex.js';
import { METRICS } from '../config/metrics.js';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';
import { now } from '../lib/time.js';
import { getLatestMetrics } from './telemetry.js';

const OPS = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '>': (a, b) => a > b,
  '>=': (a, b) => a >= b,
};
const OP_TEXT = { '<': 'di bawah', '<=': 'sama dengan atau di bawah', '>': 'di atas', '>=': 'sama dengan atau di atas' };

export function buildMessage(rule, device, value) {
  const m = METRICS[rule.metric];
  const unit = m.unit ? ` ${m.unit}` : '';
  return {
    title: `[${rule.severity.toUpperCase()}] ${rule.name}`,
    message:
      `${m.label} saat ini ${value}${unit}, ${OP_TEXT[rule.operator]} ambang batas ${rule.threshold}${unit} ` +
      `pada perangkat ${device.name}${device.zone ? ` (${device.zone})` : ''}.`,
  };
}

let running = false;

// Evaluasi semua aturan aktif satu kali. Dipanggil berkala oleh scheduler.
export async function evaluateRulesOnce(log = console) {
  if (running) return { checked: 0, triggered: 0, skipped: true };
  running = true;
  let checked = 0;
  let triggered = 0;
  try {
    const rules = await db('alert_rules').where({ is_active: true });
    const metricCache = new Map();
    const deviceMetrics = async (device) => {
      if (!metricCache.has(device.id)) {
        metricCache.set(device.id, getLatestMetrics(device).catch((err) => {
          // perangkat yang belum diisi akun ThingsBoard-nya dilewati tanpa log
          if (err.code !== 'NO_TB_CREDENTIALS') log.warn?.({ err: err.message, device: device.id }, 'alert engine: gagal mengambil telemetri');
          return null;
        }));
      }
      return metricCache.get(device.id);
    };

    for (const rule of rules) {
      const devices = rule.device_id
        ? await db('devices').where({ id: rule.device_id })
        : await db('devices').where({ greenhouse_id: rule.greenhouse_id });

      for (const device of devices) {
        const data = await deviceMetrics(device);
        const value = data?.metrics?.[rule.metric]?.value;
        if (value === null || value === undefined) continue;
        checked += 1;
        if (!OPS[rule.operator](value, rule.threshold)) continue;

        const t = now();
        const fresh = await db('alert_rules').where({ id: rule.id }).first();
        if (fresh.last_triggered_at && t - Number(fresh.last_triggered_at) < rule.cooldown_minutes * 60_000) continue;

        const { title, message } = buildMessage(rule, device, value);
        await db('alert_events').insert({
          id: newId(),
          greenhouse_id: rule.greenhouse_id,
          rule_id: rule.id,
          device_id: device.id,
          source: 'sensor',
          metric: rule.metric,
          value,
          threshold: rule.threshold,
          severity: rule.severity,
          title,
          message,
          created_at: t,
        });
        await db('alert_rules').where({ id: rule.id }).update({ last_triggered_at: t });
        triggered += 1;
      }
    }
  } finally {
    running = false;
  }
  return { checked, triggered };
}

export function startAlertEngine(app) {
  if (!env.alerts.enabled) return;
  const timer = setInterval(() => {
    evaluateRulesOnce(app.log).catch((err) => app.log.error({ err }, 'alert engine error'));
  }, env.alerts.intervalSec * 1000);
  timer.unref();
  app.addHook('onClose', async () => clearInterval(timer));
  app.log.info(`Alert engine aktif (setiap ${env.alerts.intervalSec} detik)`);
}
