# Keamanan JWT dan Session Tanova

## Ringkasan perubahan

Backend tetap menggunakan JWT Bearer. Tidak ditambahkan session-cookie dan tidak ada perubahan pada format login frontend selain access token dan refresh token tetap dikembalikan seperti sebelumnya.

Perubahan utama:

1. Access token default dipersingkat menjadi 15 menit (`JWT_ACCESS_EXPIRES=15m`).
2. Ditambahkan tabel `user_sessions` melalui migrasi `006_user_sessions.js`.
3. Setiap login membuat satu sesi server-side dengan ID sesi (`sid`). Access token dan refresh token terikat ke ID sesi tersebut.
4. Database hanya menyimpan SHA-256 hash refresh token, bukan token mentah.
5. Setiap request terautentikasi memeriksa bahwa sesi masih ada, belum dicabut, dan belum kedaluwarsa.
6. Refresh token dirotasi setiap kali endpoint refresh digunakan. Refresh token sebelumnya tidak dapat digunakan lagi. Pemakaian ulang token lama mencabut sesi terkait.
7. Ditambahkan `POST /api/v1/auth/logout` untuk mencabut sesi/perangkat saat ini.
8. Ditambahkan `POST /api/v1/auth/logout-all` untuk mencabut semua sesi pengguna sekaligus menaikkan `token_version`.
9. Mekanisme `token_version` yang sudah ada tetap dipakai untuk membatalkan seluruh token setelah perubahan/reset password atau penonaktifan akun.

## Migrasi database

Jalankan migrasi sebelum menjalankan backend:

```bash
npm run migrate
```

Jika `AUTO_MIGRATE=true`, migrasi juga dijalankan saat aplikasi mulai sesuai konfigurasi proyek. Pastikan database telah dicadangkan sebelum migrasi di lingkungan production.

## Konfigurasi environment

Atur pada `.env` backend:

```env
JWT_ACCESS_EXPIRES=15m
JWT_REFRESH_EXPIRES=7d
```

Gunakan `npm run gen-secrets` untuk menghasilkan `JWT_SECRET`, `JWT_REFRESH_SECRET`, dan `CREDENTIAL_ENCRYPTION_KEY` yang berbeda dan kuat. Jangan memakai nilai contoh atau mengunggah `.env` ke repository.

## Kontrak endpoint

### Login

`POST /api/v1/auth/login`

Tetap menerima username/password. Respons tetap memiliki `access_token`, `refresh_token`, `token_type`, `expires_in`, dan `user`.

### Refresh

`POST /api/v1/auth/refresh`

Body:

```json
{ "refresh_token": "<refresh-token-saat-ini>" }
```

Respons memberikan access token dan refresh token baru. Frontend wajib mengganti dan menyimpan KEDUA token dari respons. Jangan terus memakai refresh token sebelumnya.

### Logout perangkat saat ini

`POST /api/v1/auth/logout`

Header: `Authorization: Bearer <access_token>`

Mencabut sesi yang terkait dengan access token tersebut. Access token dari sesi yang dicabut langsung ditolak pada request API berikutnya.

### Logout semua perangkat

`POST /api/v1/auth/logout-all`

Header: `Authorization: Bearer <access_token>`

Mencabut semua sesi dan menaikkan `token_version`, sehingga seluruh access/refresh token pengguna menjadi tidak berlaku. Endpoint ini disediakan untuk kebutuhan keamanan/admin/pengaturan akun; tidak harus ditampilkan sebagai tombol dashboard.

## Pengujian Postman

1. Login dan simpan `access_token` serta `refresh_token`.
2. Panggil endpoint protected dengan access token: diharapkan `200`.
3. Panggil `/auth/refresh` dengan refresh token: diharapkan menerima pasangan token baru.
4. Ulangi refresh dengan refresh token lama: diharapkan `401`; sesi terkait dicabut karena terdeteksi penggunaan ulang.
5. Panggil endpoint protected dengan access token sesi yang dicabut: diharapkan `401`.
6. Login kembali, lalu panggil `/auth/logout` dengan access token: diharapkan berhasil. Request protected berikutnya dengan access token yang sama harus `401`.
7. Login dari dua sesi/perangkat berbeda, panggil `/auth/logout-all` dari salah satunya: kedua sesi harus ditolak setelahnya.

## Catatan integrasi frontend

- Tombol dashboard tetap cukup satu, yaitu Logout, yang memanggil `/api/v1/auth/logout`.
- Saat refresh berhasil, frontend wajib mengganti access token DAN refresh token dengan nilai terbaru.
- Jika refresh mengembalikan `401`, hapus token lokal dan arahkan pengguna ke halaman login.
- Jangan menyimpan token dalam log, URL, atau pesan error.

## Catatan kompatibilitas

Setelah migrasi ini dipasang, access token lama yang tidak memiliki `sid` akan ditolak. Semua pengguna perlu login ulang satu kali setelah deployment. Frontend lama yang tidak memperbarui refresh token setelah refresh akan mengalami kegagalan pada refresh berikutnya; integrasi refresh harus diperbarui sesuai instruksi di atas.

## Batasan

Ini merupakan pengelolaan sesi JWT server-side, bukan session-cookie. Karena setiap request protected memeriksa tabel `user_sessions`, logout dapat mencabut access token dengan segera, tetapi menambah satu query database per request autentikasi. Pastikan backup dan uji migrasi dilakukan sebelum production.
