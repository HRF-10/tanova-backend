// Migration aman untuk database lama: kolom greenhouse_id dipertahankan sementara
// untuk kompatibilitas, sedangkan relasi resmi berpindah ke user_greenhouses.
export async function up(knex) {
  const hasUsername = await knex.schema.hasColumn('users', 'username');
  if (!hasUsername) await knex.schema.alterTable('users', (t) => t.string('username', 80));
  const hasTokenVersion = await knex.schema.hasColumn('users', 'token_version');
  if (!hasTokenVersion) await knex.schema.alterTable('users', (t) => t.integer('token_version').notNullable().defaultTo(0));

  const users = await knex('users').select('id', 'email', 'username');
  for (const user of users) {
    if (user.username) continue;
    const base = String(user.email || 'user').split('@')[0].toLowerCase().replace(/[^a-z0-9_.-]/g, '').slice(0, 55) || 'user';
    let candidate = base;
    let n = 1;
    while (await knex('users').whereRaw('LOWER(username) = ?', [candidate]).whereNot({ id: user.id }).first()) {
      candidate = `${base}-${n++}`;
    }
    await knex('users').where({ id: user.id }).update({ username: candidate });
  }

  const hasPivot = await knex.schema.hasTable('user_greenhouses');
  if (!hasPivot) {
    await knex.schema.createTable('user_greenhouses', (t) => {
      t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('greenhouse_id', 36).notNullable().unique().references('id').inTable('greenhouses').onDelete('CASCADE');
      t.bigInteger('created_at').notNullable();
      t.primary(['user_id', 'greenhouse_id']);
      t.index(['user_id']);
    });
  }
  if (knex.client.config.client === 'pg') {
    await knex.raw('alter table ?? enable row level security', ['user_greenhouses']);
    await knex.raw(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.user_greenhouses from anon'; end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.user_greenhouses from authenticated'; end if;
      end $$;
    `);
  }

  const legacy = await knex('users').whereNotNull('greenhouse_id').whereNot({ role: 'admin' }).select('id', 'greenhouse_id');
  for (const row of legacy) {
    const exists = await knex('user_greenhouses').where({ greenhouse_id: row.greenhouse_id }).first();
    if (!exists) await knex('user_greenhouses').insert({ user_id: row.id, greenhouse_id: row.greenhouse_id, created_at: Date.now() });
  }

  await knex.schema.alterTable('users', (t) => t.string('username', 80).notNullable().alter());
  await knex.schema.alterTable('users', (t) => t.unique(['username'], 'users_username_unique'));
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('user_greenhouses');
  if (await knex.schema.hasColumn('users', 'token_version')) await knex.schema.alterTable('users', (t) => t.dropColumn('token_version'));
  if (await knex.schema.hasColumn('users', 'username')) await knex.schema.alterTable('users', (t) => t.dropColumn('username'));
}
