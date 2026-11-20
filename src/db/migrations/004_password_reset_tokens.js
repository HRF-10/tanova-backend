// Token reset password disimpan dalam bentuk hash, bukan token mentah.
export async function up(knex) {
  if (!(await knex.schema.hasTable('password_reset_tokens'))) {
    await knex.schema.createTable('password_reset_tokens', (t) => {
      t.string('id', 36).primary();
      t.string('user_id', 36).notNullable().references('id').inTable('users').onDelete('CASCADE');
      t.string('token_hash', 64).notNullable().unique();
      t.bigInteger('expires_at').notNullable();
      t.bigInteger('used_at');
      t.bigInteger('created_at').notNullable();
      t.index(['user_id']);
      t.index(['expires_at']);
    });
  }
  if (knex.client.config.client === 'pg') {
    await knex.raw('alter table ?? enable row level security', ['password_reset_tokens']);
    await knex.raw(`
      do $$ begin
        if exists (select 1 from pg_roles where rolname = 'anon') then execute 'revoke all on table public.password_reset_tokens from anon'; end if;
        if exists (select 1 from pg_roles where rolname = 'authenticated') then execute 'revoke all on table public.password_reset_tokens from authenticated'; end if;
      end $$;
    `);
  }
}

export async function down(knex) {
  await knex.schema.dropTableIfExists('password_reset_tokens');
}
