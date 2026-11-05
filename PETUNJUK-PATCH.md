# Patch: pindah ke Supabase dan panduan uji simulator

Patch ini hanya berisi file yang berubah. Strukturnya sama dengan folder proyek.

## Cara memasang

1. Cadangkan proyek Anda (atau commit ke Git).
2. Salin **isi folder patch ini** ke folder proyek `tanova-backend`, lalu pilih **Replace / timpa** untuk semua file. File `PETUNJUK-PATCH.md` ini tidak perlu disalin.
3. Di folder proyek jalankan: `npm install`
   (menghapus `mysql2`, memasang `pg`, dan memperbarui `package-lock.json`).
4. Ubah file `.env` Anda:
   - **Hapus** baris: `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`, `DB_AUTO_CREATE`.
   - **Tambah** baris (contoh ada di `.env.example`):
     ```
     DATABASE_URL=<connection string Supabase, tipe Session pooler>
     DB_SSL=true
     DB_POOL_MAX=5
     ```
   - Langkah mengambil connection string: `docs/PANDUAN-SUPABASE.md`.
5. Jalankan `npm run seed`, lalu `npm run dev`.
6. Buka `http://localhost:3000/health`. Isinya harus `"database":"postgres"`.
7. Database MySQL lama tidak dipakai lagi dan boleh dihapus. Datanya tidak ikut pindah.

## Daftar file

| File | Perubahan |
| --- | --- |
| `package.json` | `mysql2` diganti `pg`; skrip baru `npm run check` |
| `src/config/env.js` | Pengaturan database memakai `DATABASE_URL`, `DB_SSL`, `DB_POOL_MAX` |
| `src/db/knex.js` | Koneksi PostgreSQL dengan SSL; `bigint` dibaca sebagai angka |
| `src/db/migrations/001_init.js` | Pengaturan charset MySQL dibuang |
| `src/db/migrations/002_supabase_rls.js` | **Baru.** Mengaktifkan Row Level Security pada semua tabel agar data tidak terbuka lewat REST API publik Supabase |
| `src/modules/telemetry/routes.js`, `src/modules/users/routes.js`, `src/lib/like.js` | Pencarian memakai `ilike` (PostgreSQL membedakan huruf besar dan kecil pada `like`) |
| `src/app.js` | Label database pada `/health` |
| `tools/check-backend.js` | **Baru.** Pemeriksa otomatis backend dan simulator (`npm run check`) |
| `.env.example` | Bagian database diganti untuk Supabase |
| `docs/PANDUAN-SUPABASE.md` | **Baru.** Cara memakai Supabase |
| `docs/PANDUAN-UJI-SIMULATOR.md` | **Baru.** Cara menguji simulator pada backend asli |
| `docs/PANDUAN-ENV.md`, `README.md` | Bagian database diperbarui |

## Catatan

- Jangan memakai `npm ci` setelah patch ini. Pakai `npm install` agar `package-lock.json` diperbarui.
- Folder `src/db/migrations` sekarang berisi dua migrasi. Keduanya berjalan otomatis pada database kosong.
