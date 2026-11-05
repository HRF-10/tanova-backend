// Semua waktu disimpan sebagai epoch milidetik (bigInteger) agar portabel antar database.
export async function up(knex) {
  await knex.schema.createTable('greenhouses', (t) => {
    t.string('id', 36).primary();
    t.string('name').notNullable();
    t.string('location');
    t.string('plant_type');
    t.float('area_m2');
    t.text('description');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('users', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).references('id').inTable('greenhouses').onDelete('SET NULL');
    t.string('name').notNullable();
    t.string('email').notNullable().unique();
    t.string('phone', 30);
    t.string('job_title');
    t.string('role', 20).notNullable().defaultTo('operator'); // admin | operator | viewer
    t.string('password_hash').notNullable();
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('last_login_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('devices', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).notNullable().references('id').inTable('greenhouses').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('zone');
    t.string('type', 30).notNullable().defaultTo('controller');
    // Koneksi ThingsBoard diisi pengguna lewat GUI (per perangkat)
    t.string('tb_device_id', 64); // UUID device di ThingsBoard (Copy device ID)
    t.string('tb_url'); // kosong = memakai TB_URL dari .env
    t.string('tb_username'); // akun ThingsBoard untuk membaca telemetri dan mengirim perintah
    t.text('tb_password_enc'); // terenkripsi AES-256-GCM
    t.string('mode', 10).notNullable().defaultTo('manual'); // manual | auto
    t.text('config');
    t.text('notes');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
    t.index(['greenhouse_id']);
  });

  await knex.schema.createTable('sensors', (t) => {
    t.string('id', 36).primary();
    t.string('device_id', 36).notNullable().references('id').inTable('devices').onDelete('CASCADE');
    t.string('type', 20).notNullable(); // ph | ec | tds | water_temp | tank_level | other
    t.string('name').notNullable();
    t.string('unit', 20);
    t.string('tb_key', 60);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('created_at').notNullable();
    t.index(['device_id']);
  });

  await knex.schema.createTable('actuators', (t) => {
    t.string('id', 36).primary();
    t.string('device_id', 36).notNullable().references('id').inTable('devices').onDelete('CASCADE');
    t.string('name').notNullable();
    t.string('type', 20).notNullable().defaultTo('pump'); // pump | valve | fan | light | other
    t.string('control_key', 60).notNullable(); // dikirim ke Raspberry Pi lewat RPC
    t.string('state', 10).notNullable().defaultTo('off');
    t.bigInteger('last_command_at');
    t.string('last_command_by', 36);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('created_at').notNullable();
    t.unique(['device_id', 'control_key']);
  });

  await knex.schema.createTable('sensor_calibrations', (t) => {
    t.string('id', 36).primary();
    t.string('sensor_id', 36).notNullable().references('id').inTable('sensors').onDelete('CASCADE');
    t.bigInteger('calibrated_at').notNullable();
    t.bigInteger('due_at');
    t.string('method');
    t.text('reference_values');
    t.text('notes');
    t.string('performed_by', 36);
    t.bigInteger('created_at').notNullable();
    t.index(['sensor_id']);
  });

  await knex.schema.createTable('alert_rules', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).notNullable().references('id').inTable('greenhouses').onDelete('CASCADE');
    t.string('device_id', 36).references('id').inTable('devices').onDelete('CASCADE'); // null = semua perangkat
    t.string('created_by', 36);
    t.string('name').notNullable();
    t.string('metric', 20).notNullable();
    t.string('operator', 3).notNullable();
    t.float('threshold').notNullable();
    t.string('severity', 10).notNullable().defaultTo('warning');
    t.integer('cooldown_minutes').notNullable().defaultTo(15);
    t.boolean('is_active').notNullable().defaultTo(true);
    t.bigInteger('last_triggered_at');
    t.bigInteger('created_at').notNullable();
    t.bigInteger('updated_at').notNullable();
  });

  await knex.schema.createTable('alert_events', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).notNullable().references('id').inTable('greenhouses').onDelete('CASCADE');
    t.string('rule_id', 36).references('id').inTable('alert_rules').onDelete('SET NULL');
    t.string('device_id', 36).references('id').inTable('devices').onDelete('SET NULL');
    t.string('source', 10).notNullable().defaultTo('sensor'); // sensor | ai
    t.string('metric', 30);
    t.float('value');
    t.float('threshold');
    t.string('severity', 10).notNullable().defaultTo('warning');
    t.string('title').notNullable();
    t.text('message').notNullable();
    t.bigInteger('read_at');
    t.bigInteger('created_at').notNullable();
    t.index(['greenhouse_id', 'created_at']);
  });

  await knex.schema.createTable('ai_diagnoses', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).notNullable().references('id').inTable('greenhouses').onDelete('CASCADE');
    t.string('device_id', 36).references('id').inTable('devices').onDelete('SET NULL');
    t.bigInteger('captured_at').notNullable();
    t.string('image_url');
    t.string('category', 20).notNullable().defaultTo('leaf_health');
    t.string('label').notNullable();
    t.float('confidence'); // 0..1
    t.string('severity', 10).notNullable().defaultTo('none'); // none | low | medium | high
    t.text('details');
    t.text('recommendation');
    t.text('recommended_actions');
    t.string('action_status', 10).notNullable().defaultTo('pending'); // pending | done | dismissed
    t.bigInteger('created_at').notNullable();
    t.index(['greenhouse_id', 'captured_at']);
  });

  await knex.schema.createTable('growth_records', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36).notNullable().references('id').inTable('greenhouses').onDelete('CASCADE');
    t.string('device_id', 36).references('id').inTable('devices').onDelete('SET NULL');
    t.bigInteger('recorded_at').notNullable();
    t.float('height_cm');
    t.integer('leaf_count');
    t.float('health_score'); // 0..100
    t.text('notes');
    t.bigInteger('created_at').notNullable();
    t.index(['greenhouse_id', 'recorded_at']);
  });

  await knex.schema.createTable('activity_logs', (t) => {
    t.string('id', 36).primary();
    t.string('greenhouse_id', 36);
    t.string('user_id', 36);
    t.string('action', 60).notNullable();
    t.string('entity', 40);
    t.string('entity_id', 36);
    t.text('description');
    t.text('meta');
    t.string('ip', 64);
    t.bigInteger('created_at').notNullable();
    t.index(['greenhouse_id', 'created_at']);
  });
}

export async function down(knex) {
  for (const t of [
    'activity_logs', 'growth_records', 'ai_diagnoses', 'alert_events', 'alert_rules',
    'sensor_calibrations', 'actuators', 'sensors', 'devices', 'users', 'greenhouses',
  ]) {
    await knex.schema.dropTableIfExists(t);
  }
}
