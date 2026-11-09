# Revisi backend Tanova — manajemen akun dan greenhouse

Paket ini merupakan proyek backend lengkap, bukan patch parsial. Lakukan backup proyek dan database sebelum mengganti versi.

## Pemasangan

1. Backup folder backend dan database PostgreSQL/Supabase.
2. Ekstrak ZIP ini ke folder proyek baru atau timpa proyek lama setelah backup.
3. Pertahankan `.env` lama, terutama `DATABASE_URL`, `JWT_SECRET`, `JWT_REFRESH_SECRET`, dan `CREDENTIAL_ENCRYPTION_KEY`.
4. Jalankan `npm install`.
5. Jalankan `npm run migrate` untuk menerapkan migration baru `003_identity_and_user_greenhouses.js`.
6. Jalankan `npm run dev`.
7. Buka `/docs` untuk melihat kontrak endpoint terbaru.

## Catatan penting

- Login sekarang memakai username. Untuk akun lama, migration membentuk username dari bagian email sebelum `@`; jika bentrok ditambahkan akhiran angka. Periksa `GET /users` setelah login admin untuk melihat username.
- Registrasi publik dihapus. Admin membuat akun melalui `POST /users`.
- Relasi resmi user-greenhouse ada di `user_greenhouses`. Satu greenhouse hanya dapat ditetapkan ke satu akun.
- Admin memiliki akses global. User hanya dapat mengakses greenhouse yang ditetapkan kepadanya.
- Untuk user dengan beberapa greenhouse, frontend mengirim `?greenhouse_id=<ID>` saat memilih greenhouse.
- `users.greenhouse_id` lama masih dipertahankan sebagai kolom kompatibilitas; jangan dihapus manual.
- Role `operator` berarti user dengan izin kontrol aktuator. Role `viewer` hanya monitoring. Keduanya dapat mengubah informasi greenhouse sendiri dan mengirim konfigurasi Wi-Fi sesuai rancangan.

Dokumentasi endpoint dan contoh payload tersedia di `docs/PANDUAN-MANAJEMEN-AKUN-GREENHOUSE.md`.
