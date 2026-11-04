import { db, migrateLatest, migrateRollback } from '../db/knex.js';

try {
  if (process.argv[2] === 'rollback') {
    const [batch, files] = await migrateRollback();
    console.log(`Rollback batch ${batch}:`, files);
  } else {
    const [batch, files] = await migrateLatest();
    console.log(files.length ? `Migrasi batch ${batch} selesai:` : 'Database sudah up to date', files);
  }
} finally {
  await db.destroy();
}
