// Isi status kalibrasi awal untuk sensor yang sudah ada agar demo TANOVA Grove 1
// tampil siap pakai. Catatan ini bersifat demo, bukan sertifikasi kalibrasi hardware.
const DAY = 86_400_000;

export async function up(knex) {
  const sensors = await knex('sensors').select('id', 'type');
  const now = Date.now();
  for (const sensor of sensors) {
    const existing = await knex('sensor_calibrations').where({ sensor_id: sensor.id }).first();
    if (existing) continue;
    const intervalDays = ['ph', 'ec'].includes(sensor.type) ? 30 : 180;
    await knex('sensor_calibrations').insert({
      id: `demo-cal-${sensor.id}`.slice(0, 36),
      sensor_id: sensor.id,
      calibrated_at: now,
      due_at: now + intervalDays * DAY,
      method: 'demo-default',
      reference_values: JSON.stringify({ profile: 'Tanova Grove 1 demo' }),
      notes: 'Status awal demo; bukan hasil kalibrasi fisik perangkat.',
      performed_by: null,
      created_at: now,
    });
  }
}

export async function down(knex) {
  await knex('sensor_calibrations').where({ method: 'demo-default' }).del();
}
