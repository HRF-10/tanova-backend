# Panduan revisi manajemen akun dan greenhouse Tanova

## Perubahan utama

- Login Tanova memakai `username` dan `password`, bukan email.
- Registrasi publik `/auth/register` dihilangkan. Admin membuat akun.
- Password Tanova disimpan dengan bcrypt.
- Tabel `user_greenhouses` menjadi relasi resmi user dan greenhouse (many-to-many dengan batas unik pada `greenhouse_id`).
- Satu user dapat memiliki beberapa greenhouse, tetapi satu greenhouse hanya dapat dimiliki satu user.
- Kolom `users.greenhouse_id` lama dipertahankan sementara untuk kompatibilitas data dan ditulis sebagai greenhouse pertama. Gunakan `user_greenhouses` untuk relasi resmi.
- Admin mempunyai akses global; user dibatasi pada greenhouse yang ditetapkan.
- ID greenhouse dibuat server dan tidak dapat diubah melalui API.

## Upgrade database yang sudah ada

1. Backup database PostgreSQL/Supabase terlebih dahulu.
2. Perbarui file proyek dengan versi revisi ini.
3. Pastikan `.env` lama tetap berisi `DATABASE_URL`, `DB_SSL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, dan `CREDENTIAL_ENCRYPTION_KEY` yang sama. Jangan mengganti kunci enkripsi ThingsBoard ketika sudah ada kredensial terenkripsi.
4. Jalankan `npm install` bila dependensi belum terpasang.
5. Jalankan `npm run migrate` atau mulai server jika `DB_AUTO_MIGRATE=true`.
6. Migration `003_identity_and_user_greenhouses.js` menambahkan username dari bagian sebelum `@` pada email akun lama, menambahkan tabel relasi, dan memindahkan greenhouse lama dari user non-admin. Akun admin tidak dianggap sebagai pemilik greenhouse.
7. Akun lama login menggunakan username hasil migrasi. Contoh email `budi@example.com` akan menjadi username `budi`, kecuali ada benturan; jika bentrok, migration menambahkan akhiran angka.
8. Jalankan `npm run seed` hanya bila ingin membuat data demo/admin awal pada database yang belum memiliki akun admin seed. Seed tidak mengubah akun yang sudah ada.

> Migration tidak menghapus kolom lama `users.greenhouse_id` agar kompatibel dengan data/proses yang sudah berjalan. Jangan menghapus kolom tersebut sebelum semua integrasi lama diperiksa.

## Endpoint akun

### Login user/admin

`POST /api/v1/auth/login`

```json
{ "username": "pengguna01", "password": "password-awal" }
```

### Admin membuat akun

`POST /api/v1/users`

```json
{
  "name": "Pengguna Tanova",
  "username": "pengguna01",
  "email": "pengguna@example.com",
  "password": "password-awal",
  "phone": "08123456789",
  "role": "operator",
  "greenhouse_ids": ["ID_GREENHOUSE_1", "ID_GREENHOUSE_2"]
}
```

`role` yang diterima: `admin`, `operator`, atau `viewer`. Pembuatan role admin hanya dapat dilakukan oleh admin yang sudah terautentikasi.

### Admin mengubah akun

`PATCH /api/v1/users/:id`

Field yang dapat diubah: `name`, `username`, `email`, `phone`, `role`, `is_active`.

### Admin reset password

`PUT /api/v1/users/:id/password`

```json
{ "password": "password-baru-minimal-8-karakter" }
```

Sampaikan password awal melalui kanal yang aman. Reset password dan perubahan status akun menaikkan `token_version`, sehingga access token dan refresh token lama tidak dapat digunakan lagi.

### Admin menetapkan atau memindahkan greenhouse

`PUT /api/v1/users/:id/greenhouses`

```json
{ "greenhouse_ids": ["ID_GREENHOUSE_1", "ID_GREENHOUSE_2"] }
```

Daftar yang dikirim menggantikan seluruh penetapan sebelumnya. Kirim array kosong untuk melepas semua greenhouse. Jika greenhouse sudah dimiliki akun lain, endpoint ini memindahkan kepemilikannya secara atomik dari akun lama ke akun tujuan. Endpoint pembuatan akun (`POST /users`) tidak mengambil alih greenhouse yang sudah dimiliki akun lain.

## Endpoint greenhouse

- `GET /api/v1/greenhouses`: admin melihat semua; user hanya greenhouse yang ditetapkan.
- `GET /api/v1/greenhouses/:id`: detail dan daftar device sesuai hak akses.
- `POST /api/v1/greenhouses`: admin membuat greenhouse; ID dibuat otomatis.
- `PATCH /api/v1/greenhouses/:id`: admin atau pemilik mengubah `name`, `location`, `plant_type`, `area_m2`, `description`.
- `DELETE /api/v1/greenhouses/:id`: admin saja.

## Tambah device sekaligus greenhouse baru

`POST /api/v1/devices` (admin) dapat menerima `greenhouse` untuk membuat greenhouse dan device dalam satu transaksi:

```json
{
  "name": "Tanova Controller 02",
  "greenhouse": {
    "name": "Greenhouse Timur",
    "location": "Surakarta",
    "plant_type": "Selada",
    "area_m2": 30,
    "description": "Area produksi timur"
  },
  "tb_device_id": "UUID-DEVICE-THINGSBOARD",
  "tb_username": "tenant@example.com",
  "tb_password": "password-thingsboard"
}
```

Untuk greenhouse yang sudah ada, kirim `greenhouse_id` sebagai gantinya. Setelah device dibuat, admin dapat menetapkan greenhouse kepada akun user melalui endpoint penetapan greenhouse.

## Hak akses ringkas

| Fitur | Admin | Operator | Viewer |
|---|---:|---:|---:|
| Lihat semua greenhouse/device | Ya | Tidak | Tidak |
| Kelola akun dan kepemilikan | Ya | Tidak | Tidak |
| Buat/edit/hapus device dan koneksi ThingsBoard | Ya | Tidak | Tidak |
| Edit informasi greenhouse milik sendiri | Ya | Ya | Ya |
| Monitoring dan riwayat telemetri | Ya | Ya | Ya |
| Konfigurasi Wi-Fi device dalam greenhouse sendiri | Ya | Ya | Ya |
| Kontrol aktuator manual | Ya | Ya | Tidak |
| Ubah konfigurasi kontrol ThingsBoard/device | Ya | Tidak | Tidak |
| Ganti password akun sendiri | Ya | Ya | Ya |

Untuk user yang memiliki beberapa greenhouse, frontend perlu menyertakan `greenhouse_id` pada query endpoint yang mendukung pemilihan greenhouse. Jika tidak dikirim, backend memakai greenhouse pertama yang ditetapkan ke akun.
