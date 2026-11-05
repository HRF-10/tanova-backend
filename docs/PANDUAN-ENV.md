# Panduan mengisi file `.env` backend

File `.env` berisi pengaturan yang berbeda di tiap komputer, misalnya password database dan kunci rahasia. Kode tidak berubah, hanya isi `.env` yang disesuaikan.

## Cara cepat (5 menit)

1. Salin contohnya: `cp .env.example .env` (di Windows: salin file `.env.example` lalu ganti namanya menjadi `.env`).
2. Buat tiga kunci rahasia otomatis: `npm run gen-secrets`. Hasilnya tiga baris. Salin ke `.env` dan ganti baris lama yang namanya sama (`JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDENTIAL_ENCRYPTION_KEY`).
3. Isi `DATABASE_URL` dengan connection string dari Supabase (caranya di `docs/PANDUAN-SUPABASE.md`).
4. Simpan, lalu jalankan `npm run seed` dan `npm run dev`.
5. Setiap kali `.env` diubah, **backend harus dijalankan ulang**.

Aturan penulisan:

- Satu baris satu pengaturan, bentuknya `NAMA=nilai`, tanpa spasi di sekitar tanda sama dengan.
- Baris yang diawali `#` adalah komentar dan diabaikan.
- Jika nilai berisi tanda `#` (misalnya password), tulis dalam tanda kutip: `DB_PASSWORD="abc#123"`.
- Jangan unggah `.env` ke Git atau kirim ke orang lain. Yang boleh dibagikan hanya `.env.example`.

## Penjelasan JWT dengan bahasa sederhana

Saat pengguna login, backend memberi dua "tiket" digital yang disebut **token JWT**:

- **Access token**: tiket yang dikirim aplikasi di setiap permintaan. Masa berlakunya pendek (`JWT_ACCESS_EXPIRES`, bawaan 12 jam).
- **Refresh token**: tiket cadangan yang lebih lama (`JWT_REFRESH_EXPIRES`, bawaan 7 hari). Dipakai untuk meminta access token baru tanpa login ulang.

Supaya tiket tidak bisa dipalsukan, backend menandatanganinya dengan kunci rahasia: `JWT_SECRET` untuk access token dan `JWT_REFRESH_SECRET` untuk refresh token. Siapa pun yang tahu kunci itu bisa membuat tiket palsu, jadi kunci harus panjang, acak, dan rahasia. Karena itu pakai `npm run gen-secrets`, jangan mengarang sendiri.

- Jika `JWT_SECRET` diganti, semua pengguna yang sedang login harus login ulang. Ini normal dan tidak merusak data.
- Dua kunci JWT harus **berbeda** satu sama lain.
- Format durasi: `15m` menit, `12h` jam, `7d` hari.

## Daftar pengaturan

### Server

| Nama | Arti | Contoh |
| --- | --- | --- |
| `NODE_ENV` | `development` saat mengembangkan, `production` saat dipasang di server. Mode `production` menolak jalan bila kunci rahasia masih bawaan | `development` |
| `PORT` | Nomor port backend | `3000` |
| `HOST` | Alamat yang didengarkan. `0.0.0.0` berarti bisa diakses dari perangkat lain di jaringan | `0.0.0.0` |
| `CORS_ORIGIN` | Alamat web frontend yang diizinkan memanggil backend. Pisahkan dengan koma. `*` berarti semua (hanya untuk pengembangan) | `http://localhost:5173` |

Jika browser menampilkan galat CORS, nilai `CORS_ORIGIN` belum sama dengan alamat frontend Anda (termasuk nomor port).

### Keamanan

| Nama | Arti |
| --- | --- |
| `JWT_SECRET` | Kunci penanda access token |
| `JWT_REFRESH_SECRET` | Kunci penanda refresh token |
| `JWT_ACCESS_EXPIRES` | Masa berlaku access token |
| `JWT_REFRESH_EXPIRES` | Masa berlaku refresh token |
| `CREDENTIAL_ENCRYPTION_KEY` | Kunci pengunci password ThingsBoard yang disimpan pengguna di database |

`CREDENTIAL_ENCRYPTION_KEY` berbeda dari JWT. Kunci ini **jangan diganti** setelah ada pengguna yang menyimpan koneksi ThingsBoard, karena password lama tidak akan terbaca lagi (pengguna harus mengisi ulang). Simpan salinannya di tempat aman.

### Database (Supabase)

| Nama | Arti | Bawaan |
| --- | --- | --- |
| `DATABASE_URL` | Connection string PostgreSQL dari Supabase (tombol Connect, tipe Session pooler). **Wajib diisi** | kosong |
| `DB_SSL` | `true` = koneksi terenkripsi SSL. Supabase mewajibkannya. `false` hanya untuk PostgreSQL lokal | `true` |
| `DB_POOL_MAX` | Jumlah koneksi maksimal ke database. Paket gratis terbatas, jadi jangan dinaikkan tanpa perlu | `5` |
| `AUTO_MIGRATE` | `true` = buat dan perbarui tabel otomatis saat start | `true` |

Jika password database mengandung karakter khusus (`@`, `#`, `/`, `:`), password di dalam `DATABASE_URL` harus di-URL-encode. Lebih mudah: reset password Supabase menjadi huruf dan angka saja. Detailnya ada di `docs/PANDUAN-SUPABASE.md`.

### ThingsBoard

| Nama | Arti |
| --- | --- |
| `THINGSBOARD_MOCK` | `true` = data sensor palsu dari backend sendiri, tanpa ThingsBoard sama sekali. Cocok untuk membuat tampilan frontend. `false` = memakai ThingsBoard sungguhan (bisa juga dengan simulator) |
| `TB_URL` | Alamat **web** ThingsBoard. Cloud: `https://thingsboard.cloud`. ThingsBoard tiruan lokal: `http://localhost:8099`. Bukan alamat MQTT |
| `TB_USERNAME`, `TB_PASSWORD` | Boleh dikosongkan. Akun ThingsBoard diisi pengguna dari GUI. Dua baris ini hanya cadangan untuk perangkat yang belum diisi akunnya |
| `TB_RPC_MODE` | `twoway` = backend menunggu balasan perangkat (disarankan). `oneway` = kirim saja |
| `TB_TIMEOUT_MS` | Batas waktu permintaan ke ThingsBoard (milidetik) |
| `TB_KEY_*` | Nama key telemetri di ThingsBoard. Ubah hanya bila service memakai nama lain |
| `TDS_FACTOR` | TDS (ppm) = EC (mS/cm) dikali angka ini. Bawaan 500 |
| `TELEMETRY_STALE_SECONDS` | Data sensor yang lebih tua dari ini (detik) dianggap basi |
| `MANUAL_MAX_DURATION` | Batas lama dosis manual (detik). Samakan dengan service |

### Peringatan dan unggahan

| Nama | Arti |
| --- | --- |
| `ALERT_ENGINE_ENABLED` | `true` = backend memeriksa aturan peringatan secara berkala |
| `ALERT_CHECK_INTERVAL_SEC` | Seberapa sering memeriksa (detik) |
| `UPLOAD_DIR` | Folder penyimpanan foto dari aplikasi |
| `MAX_UPLOAD_MB` | Ukuran maksimal foto (MB) |

### Seed

`SEED_ADMIN_EMAIL` dan `SEED_ADMIN_PASSWORD` dipakai oleh `npm run seed` untuk membuat akun admin pertama. Setelah login, ganti passwordnya.

## Contoh siap pakai

**A. Mengembangkan frontend tanpa alat dan tanpa ThingsBoard**

```
NODE_ENV=development
PORT=3000
CORS_ORIGIN=http://localhost:5173
JWT_SECRET=<hasil gen-secrets>
JWT_REFRESH_SECRET=<hasil gen-secrets>
CREDENTIAL_ENCRYPTION_KEY=<hasil gen-secrets>
DATABASE_URL=<connection string Supabase>
DB_SSL=true
THINGSBOARD_MOCK=true
```

**B. Menguji dengan ThingsBoard sungguhan dan simulator**

Sama seperti A, tetapi `THINGSBOARD_MOCK=false` dan `TB_URL=https://thingsboard.cloud`. Device ID dan akun ThingsBoard diisi dari GUI.

**C. Di server (produksi)**

- `NODE_ENV=production`
- Tiga kunci rahasia dibuat baru dengan `npm run gen-secrets`
- `CORS_ORIGIN` berisi alamat frontend yang sebenarnya, bukan `*`
- `DATABASE_URL` memakai password database yang kuat, dan password admin seed diganti
- `THINGSBOARD_MOCK=false`

## Gejala dan penyebabnya

| Pesan atau gejala | Penyebab | Perbaikan |
| --- | --- | --- |
| `DATABASE_URL belum diisi` | Baris `DATABASE_URL` kosong | Isi connection string dari Supabase |
| `password authentication failed` | Password database salah, atau karakter khusus belum di-encode | Reset password Supabase ke huruf dan angka |
| `ENOTFOUND` atau `ETIMEDOUT` ke `db.xxx.supabase.co` | Memakai Direct connection (hanya IPv6) | Pakai tipe Session pooler |
| `Tenant or user not found` | Nama pengguna pooler salah | Salin ulang string dari tombol Connect |
| `JWT_SECRET dan CREDENTIAL_ENCRYPTION_KEY wajib diganti` | Mode production dengan kunci bawaan | Jalankan `npm run gen-secrets` |
| Semua pengguna tiba-tiba logout | `JWT_SECRET` diganti | Wajar, login ulang |
| Password ThingsBoard yang tersimpan tidak terbaca | `CREDENTIAL_ENCRYPTION_KEY` diganti | Pengguna mengisi ulang koneksi |
| Galat CORS di browser | `CORS_ORIGIN` tidak cocok | Samakan dengan alamat frontend |
| Perubahan `.env` tidak berpengaruh | Backend belum dijalankan ulang | Hentikan lalu jalankan lagi |
