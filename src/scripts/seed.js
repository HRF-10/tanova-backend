import bcrypt from 'bcryptjs';
import { db, migrateLatest } from '../db/knex.js';
import { env } from '../config/env.js';
import { newId } from '../lib/ids.js';
import { toJson } from '../lib/json.js';
import { recommend } from '../services/recommendations.js';

const DAY = 86_400_000;

try {
  await migrateLatest();
  const email = env.seed.adminEmail.toLowerCase();
  if (await db('users').where({ email }).first()) {
    console.log(`Admin ${email} sudah ada, seed dilewati.`);
  } else {
    const t = Date.now();
    const ghId = newId();
    await db('greenhouses').insert({
      id: ghId, name: 'Tanova Grove Demo', location: 'Surakarta, Jawa Tengah', plant_type: 'Selada hidroponik', area_m2: 24,
      description: 'Greenhouse contoh untuk pengembangan', created_at: t, updated_at: t,
    });
    const adminId = newId();
    await db('users').insert({
      id: adminId, greenhouse_id: null, name: 'Admin Tanova', username: env.seed.adminUsername, email, job_title: 'Administrator', role: 'admin',
      password_hash: await bcrypt.hash(env.seed.adminPassword, 12), is_active: true, created_at: t, updated_at: t,
    });

    const deviceId = newId();
    await db('devices').insert({
      id: deviceId, greenhouse_id: ghId, name: 'Tanova Grove 01', zone: 'Zona A', type: 'controller',
      tb_device_id: env.tb.mock ? 'mock-device-1' : null, mode: 'manual', config: toJson({ firmware: '1.0.0' }), created_at: t, updated_at: t,
    });
    await db('sensors').insert([
      { type: 'ph', name: 'Sensor pH', unit: '', tb_key: env.tb.keys.ph },
      { type: 'ec', name: 'Sensor EC/TDS', unit: 'mS/cm', tb_key: env.tb.keys.ec },
      { type: 'water_temp', name: 'Sensor Suhu Air', unit: '°C', tb_key: env.tb.keys.water_temp },
      { type: 'air_temp', name: 'Sensor Suhu Udara', unit: '°C', tb_key: env.tb.keys.air_temp },
      { type: 'humidity', name: 'Sensor Kelembapan', unit: '%', tb_key: env.tb.keys.humidity },
      { type: 'waterflow', name: 'Sensor Aliran Air', unit: '', tb_key: env.tb.keys.waterflow },
    ].map((x) => ({ id: newId(), device_id: deviceId, is_active: true, created_at: t, ...x })));
    await db('actuators').insert([
      { name: 'Pompa Nutrisi A', type: 'dosing_pump', control_key: 'pump_ec_a' },
      { name: 'Pompa Nutrisi B', type: 'dosing_pump', control_key: 'pump_ec_b' },
      { name: 'Pompa pH Up', type: 'dosing_pump', control_key: 'pump_ph_up' },
      { name: 'Pompa pH Down', type: 'dosing_pump', control_key: 'pump_ph_down' },
      { name: 'Pompa Utama A', type: 'pump', control_key: 'pump_a' },
      { name: 'Pompa Utama B', type: 'pump', control_key: 'pump_b' },
      { name: 'Kipas', type: 'fan', control_key: 'fan' },
      { name: 'Pemanas', type: 'heater', control_key: 'heater' },
    ].map((x) => ({ id: newId(), device_id: deviceId, state: 'off', is_active: true, created_at: t, ...x })));

    // Data contoh Tanova AI: 14 hari skor kesehatan + 2 diagnosis
    await db('growth_records').insert(Array.from({ length: 14 }, (_, i) => ({
      id: newId(), greenhouse_id: ghId, device_id: deviceId, recorded_at: t - (13 - i) * DAY,
      height_cm: Math.round((4 + i * 1.1) * 10) / 10, leaf_count: 4 + Math.floor(i * 0.9),
      health_score: Math.min(98, 80 + i * 1.2 + (i % 3)), created_at: t,
    })));
    const demo = [
      { label: 'Daun sehat', severity: 'none', confidence: 0.94, category: 'leaf_health', days: 1 },
      { label: 'Defisiensi Kalsium', severity: 'medium', confidence: 0.82, category: 'nutrient', days: 0 },
    ];
    await db('ai_diagnoses').insert(demo.map((d) => {
      const r = recommend(d.label);
      return {
        id: newId(), greenhouse_id: ghId, device_id: deviceId, captured_at: t - d.days * DAY, category: d.category, label: d.label,
        confidence: d.confidence, severity: d.severity, recommendation: r.recommendation, recommended_actions: toJson(r.actions),
        action_status: 'pending', created_at: t,
      };
    }));
    console.log(`Seed selesai.\nUsername: ${env.seed.adminUsername}\nEmail  : ${email}\nPassword: ${env.seed.adminPassword}\n(Segera ganti password setelah login.)`);
  }
} finally {
  await db.destroy();
}
