// API key per user disimpan dalam bentuk hash SHA-256 (untuk lookup cepat) dan terenkripsi AES-256-GCM (agar bisa dikembalikan saat login).
export async function up(knex) {
  if (!(await knex.schema.hasColumn('users', 'api_key_hash'))) {
    await knex.schema.alterTable('users', (t) => {
      t.string('api_key_hash', 64).unique();
      t.text('api_key_enc');
    });
  }
}

export async function down(knex) {
  if (await knex.schema.hasColumn('users', 'api_key_hash')) {
    await knex.schema.alterTable('users', (t) => {
      t.dropColumn('api_key_hash');
      t.dropColumn('api_key_enc');
    });
  }
}
