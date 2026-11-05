// KEAMANAN SUPABASE
// Supabase otomatis membuka semua tabel di schema "public" lewat REST API publik (memakai anon key yang
// tertanam di aplikasi). Tanpa Row Level Security, siapa pun yang memegang anon key bisa membaca dan menulis
// tabel ini, termasuk hash password. Di sini RLS diaktifkan pada semua tabel TANPA policy, sehingga peran
// anon dan authenticated tidak bisa mengakses apa pun. Backend tetap berjalan normal karena terhubung
// sebagai pemilik tabel (role postgres) yang tidak terkena RLS.
//
// PENTING: setiap migrasi yang membuat tabel baru juga harus menjalankan
//   await knex.raw('alter table ?? enable row level security', ['nama_tabel']);
export async function up(knex) {
  if (knex.client.config.client !== 'pg') return;
  const { rows } = await knex.raw('select tablename from pg_tables where schemaname = current_schema()');
  for (const { tablename } of rows) {
    await knex.raw('alter table ?? enable row level security', [tablename]);
  }
  // Pada Supabase, cabut juga hak akses peran publik. Di PostgreSQL biasa blok ini tidak melakukan apa-apa.
  await knex.raw(`
    do $$
    begin
      if exists (select 1 from pg_roles where rolname = 'anon') then
        execute 'revoke all on all tables in schema public from anon';
      end if;
      if exists (select 1 from pg_roles where rolname = 'authenticated') then
        execute 'revoke all on all tables in schema public from authenticated';
      end if;
    end $$;
  `);
}

export async function down() {}
