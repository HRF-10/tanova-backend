// Menyimpan sesi JWT aktif. Refresh token disimpan sebagai SHA-256 hash, bukan token mentah.
export async function up(knex) {
  if (!(await knex.schema.hasTable('user_sessions'))) {
    await knex.schema.createTable('user_sessions', (t) => {
      t.string('id', 36).primary();
      t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('refresh_token_hash', 64).notNullable().unique();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('created_at').notNullable();
      t.bigInteger('last_used_at').notNullable();
      t.bigInteger('revoked_at').nullable();
      t.index(['user_id', 'revoked_at']);
      t.index(['expires_at']);
    });
  }
  if (knex.client.config.client === 'pg') {
    await knex.raw('alter table ?? enable row level security', ['user_sessions']);
    await knex.raw(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.user_sessions from anon'; end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.user_sessions from authenticated'; end if;
      end $$;
    `);
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('user_sessions');
}
