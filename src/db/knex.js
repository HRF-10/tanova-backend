import knex from 'knex';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../config/env.js';

const here = path.dirname(fileURLToPath(import.meta.url));
export const migrationsDir = path.join(here, 'migrations');

const connection = (database) => ({
  host: env.db.host,
  port: env.db.port,
  user: env.db.user,
  password: env.db.password,
  database,
  charset: 'utf8mb4',
});

export const db = knex({
  client: env.db.client,
  connection: connection(env.db.name),
  pool: { min: 0, max: 10 },
});

// Buat database bila belum ada (butuh hak CREATE pada user MySQL). Gagal diam-diam jika tidak berhak.
export async function ensureDatabase() {
  if (!env.db.autoCreate) return;
  const admin = knex({ client: env.db.client, connection: connection(undefined), pool: { min: 0, max: 1 } });
  try {
    await admin.raw(`CREATE DATABASE IF NOT EXISTS ?? CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`, [env.db.name]);
  } catch (err) {
    console.warn(`Tidak dapat membuat database "${env.db.name}" otomatis: ${err.message}`);
  } finally {
    await admin.destroy();
  }
}

export async function migrateLatest() {
  await ensureDatabase();
  return db.migrate.latest({ directory: migrationsDir, loadExtensions: ['.js'] });
}

export async function migrateRollback() {
  return db.migrate.rollback({ directory: migrationsDir, loadExtensions: ['.js'] });
}
