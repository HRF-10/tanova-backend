import { env } from './env.js';

// Definisi metrik utama dashboard. Rentang normal/warning dipakai untuk label status.
export const METRICS = {
  ph: { label: 'pH', unit: '', tbKey: env.tb.keys.ph, normal: [5.5, 6.5], warning: [5.0, 7.0], decimals: 2 },
  ec: { label: 'EC', unit: 'mS/cm', tbKey: env.tb.keys.ec, normal: [1.2, 2.5], warning: [0.8, 3.0], decimals: 2 },
  tds: { label: 'TDS', unit: 'ppm', tbKey: env.tb.keys.tds, normal: [600, 1250], warning: [400, 1500], decimals: 0 },
  water_temp: { label: 'Suhu Air', unit: '°C', tbKey: env.tb.keys.water_temp, normal: [20, 28], warning: [18, 32], decimals: 1 },
  air_temp: { label: 'Suhu Udara', unit: '°C', tbKey: env.tb.keys.air_temp, normal: [20, 32], warning: [15, 38], decimals: 1 },
  humidity: { label: 'Kelembapan', unit: '%', tbKey: env.tb.keys.humidity, normal: [50, 85], warning: [35, 95], decimals: 0 },
  waterflow: { label: 'Aliran Air', unit: '', tbKey: env.tb.keys.waterflow, normal: [0.1, 1000], warning: [0, 1000], decimals: 2 },
  tank_level: { label: 'Level Tangki', unit: '%', tbKey: env.tb.keys.tank_level, normal: [40, 100], warning: [20, 100], decimals: 0 },
};

// Status relay yang dilaporkan service_1.py sebagai telemetri (true/false), sama dengan control_key aktuator
export const DEVICE_STATUS_KEYS = ['pump_ec_a', 'pump_ec_b', 'pump_ph_up', 'pump_ph_down', 'pump_a', 'pump_b', 'fan', 'heater'];

export const METRIC_NAMES = Object.keys(METRICS);

// Interval kalibrasi (hari) per jenis sensor
export const CALIBRATION_INTERVAL_DAYS = {
  ph: 30,
  ec: 30,
  tds: 30,
  water_temp: 180,
  air_temp: 180,
  humidity: 180,
  waterflow: 180,
  tank_level: 180,
  other: 90,
};

export function metricStatus(metric, value) {
  const m = METRICS[metric];
  if (!m || value === null || value === undefined) return 'unknown';
  if (value >= m.normal[0] && value <= m.normal[1]) return 'normal';
  if (value >= m.warning[0] && value <= m.warning[1]) return 'warning';
  return 'critical';
}
