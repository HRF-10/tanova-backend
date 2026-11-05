# Panduan memakai Supabase sebagai database

Backend memakai Supabase hanya sebagai **database PostgreSQL**. Login, JWT, dan kontrol akses tetap diurus oleh backend sendiri. Karena itu backend hanya butuh satu hal dari Supabase: **connection string**.

Kunci `anon` dan `service_role` milik Supabase **tidak dipakai** dan tidak perlu disalin ke `.env`.

## 1. Membuat proyek dan mengambil connection string

1. Masuk ke supabase.com lalu buat proyek baru (**New project**).
2. Isi **Database password** saat membuat proyek. Disarankan hanya huruf dan angka (lihat bagian 3). Catat passwordnya.
3. Pilih region yang dekat dengan pengguna (misalnya Singapore).
4. Setelah proyek siap, klik tombol **Connect** di bagian atas dashboard proyek (atau buka **Project Settings > Database > Connection string**).
5. Pilih tipe **Session pooler**, lalu salin string-nya. Bentuknya seperti:

```
postgresql://postgres.abcdefghijkl:[YOUR-PASSWORD]@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
```

6. Ganti `[YOUR-PASSWORD]` dengan password database Anda (tanpa tanda kurung siku), lalu tempel ke `.env`:

```
DATABASE_URL=postgresql://postgres.abcdefghijkl:PasswordAnda@aws-0-ap-southeast-1.pooler.supabase.com:5432/postgres
DB_SSL=true
```

## 2. Kenapa Session pooler

| Pilihan di Supabase | Kapan dipakai |
| --- | --- |
| **Session pooler** (port 5432) | **Dipakai backend ini.** Berjalan di jaringan IPv4 biasa dan cocok untuk server yang menyala terus |
| Transaction pooler (port 6543) | Untuk layanan serverless. Backend ini juga bisa memakainya |
| Direct connection | Hanya IPv6 pada paket gratis. Di banyak jaringan rumah dan kampus gagal tersambung (`ENOTFOUND` atau `ETIMEDOUT`) |

## 3. Password dengan karakter khusus

Password di dalam connection string harus di-URL-encode. Contoh: `@` menjadi `%40`, `#` menjadi `%23`, `/` menjadi `%2F`, `:` menjadi `%3A`, `?` menjadi `%3F`.

Cara termudah: reset password menjadi huruf dan angka saja di **Project Settings > Database > Reset database password**, lalu perbarui `DATABASE_URL`.

## 4. Pertama kali dijalankan

1. Isi `DATABASE_URL` seperti di atas.
2. Jalankan `npm run seed`. Tabel dibuat otomatis lewat migrasi, lalu akun admin dan data contoh dibuat.
3. Di Supabase, buka **Table Editor**. Tabel `users`, `devices`, `sensors`, `actuators`, dan lainnya sudah ada.
4. Jalankan `npm run dev`, lalu buka `http://localhost:3000/health`. Isinya harus `"database":"postgres"`.

## 5. Keamanan: Row Level Security

Supabase otomatis membuka tabel di schema `public` lewat REST API publiknya, yang dapat diakses dengan kunci `anon` (kunci ini biasanya tertanam di aplikasi). Tanpa perlindungan, siapa pun yang memegang kunci itu bisa membaca dan menulis tabel, termasuk hash password.

Migrasi `002_supabase_rls.js` mengatasinya:

- Mengaktifkan **Row Level Security (RLS)** pada semua tabel **tanpa policy**, sehingga peran `anon` dan `authenticated` tidak bisa mengakses apa pun.
- Backend tidak terpengaruh karena terhubung sebagai pemilik tabel (`postgres`).
- Di Table Editor, tabel tampil dengan label RLS aktif. Itu normal dan disengaja.

Jika suatu saat Anda menambah migrasi yang membuat tabel baru, tambahkan di migrasi itu:

```js
await knex.raw('alter table ?? enable row level security', ['nama_tabel']);
```

## 6. Masalah yang sering muncul

| Pesan | Penyebab | Perbaikan |
| --- | --- | --- |
| `DATABASE_URL belum diisi` | Baris belum diisi di `.env` | Isi connection string |
| `password authentication failed` | Password salah, atau karakter khusus belum di-encode | Reset password ke huruf dan angka |
| `Tenant or user not found` | Nama pengguna salah. Pada pooler harus `postgres.<ref proyek>` | Salin ulang string dari tombol Connect |
| `ENOTFOUND` atau `ETIMEDOUT` ke `db.xxx.supabase.co` | Memakai Direct connection yang hanya IPv6 | Pakai Session pooler |
| `no pg_hba.conf entry ... no encryption` | `DB_SSL=false` padahal Supabase mewajibkan SSL | Set `DB_SSL=true` |
| `too many clients` atau `max clients reached` | Terlalu banyak koneksi terbuka | Turunkan `DB_POOL_MAX` (misalnya 3) |
| Semua permintaan gagal setelah lama tidak dipakai | Proyek gratis otomatis dijeda setelah sekitar seminggu tanpa aktivitas | Buka dashboard Supabase lalu **Restore project** |

## 7. Catatan

- Data dari MySQL tidak ikut pindah. Karena aplikasi belum dipakai produksi, mulai dari database kosong di Supabase.
- Foto dari aplikasi masih disimpan di folder `uploads` pada server backend. Jika backend nanti dipasang di layanan yang diskusnya bersifat sementara, foto perlu dipindah ke Supabase Storage (belum dikerjakan).
- Backup: paket gratis tidak menyediakan backup otomatis harian. Ekspor data secara berkala bila datanya penting.
