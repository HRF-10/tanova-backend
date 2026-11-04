import { db } from '../db/knex.js';
import { CALIBRATION_INTERVAL_DAYS } from '../config/metrics.js';
import { dto } from '../lib/dto.js';

const DAY = 86_400_000;

export function calibrationStatus(lastRow, nowMs = Date.now()) {
  if (!lastRow) return 'never';
  const due = Number(lastRow.due_at);
  if (nowMs > due) return 'overdue';
  if (due - nowMs < 7 * DAY) return 'due_soon';
  return 'ok';
}

export function defaultDueAt(sensorType, calibratedAt) {
  return calibratedAt + (CALIBRATION_INTERVAL_DAYS[sensorType] || CALIBRATION_INTERVAL_DAYS.other) * DAY;
}

// Status kalibrasi terbaru untuk daftar sensor.
export async function calibrationOverview(sensors) {
  if (!sensors.length) return [];
  const rows = await db('sensor_calibrations')
    .whereIn('sensor_id', sensors.map((s) => s.id))
    .orderBy('calibrated_at', 'desc');
  const latest = new Map();
  for (const r of rows) if (!latest.has(r.sensor_id)) latest.set(r.sensor_id, r);

  return sensors.map((s) => {
    const last = latest.get(s.id) || null;
    return {
      sensor_id: s.id,
      device_id: s.device_id,
      sensor_name: s.name,
      sensor_type: s.type,
      is_active: Boolean(s.is_active),
      status: calibrationStatus(last),
      last_calibrated_at: last ? new Date(Number(last.calibrated_at)).toISOString() : null,
      due_at: last?.due_at ? new Date(Number(last.due_at)).toISOString() : null,
      last_calibration: last ? dto(last, { json: ['reference_values'] }) : null,
    };
  });
}
