import knex from 'knex';
import pg from 'pg';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.join(here, 'migrations');

if (!env.db.url) {
  throw new Error('DATABASE_URL belum diisi. Salin connection string dari Supabase (Project Settings > Database) ke file .env');
}

// PostgreSQL mengembalikan bigint (int8) sebagai teks. Waktu disimpan sebagai epoch milidetik dan jumlah (count)
// bertipe bigint, keduanya aman dibaca sebagai angka biasa.
pg.types.setTypeParser(20, (value) => Number(value));

export const db = knex({
  client: 'pg',
  connection: {
    connectionString: env.db.url,
    // Sertifikat pooler Supabase tidak ada di daftar CA bawaan Node, jadi verifikasi sertifikat dimatikan
    // (koneksi tetap terenkripsi).
    ssl: env.db.ssl ? { rejectUnauthorized: false } : false,
  },
  pool: { min: 0, max: env.db.poolMax },
});

export async function migrateLatest() {
  return db.migrate.latest({ directory: migrationsDir, loadExtensions: ['.js'] });
}

export async function migrateRollback() {
  return db.migrate.rollback({ directory: migrationsDir, loadExtensions: ['.js'] });
}
