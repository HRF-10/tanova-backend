# Panduan menguji simulator pada backend asli

"Backend asli" di sini berarti backend yang berjalan sungguhan dengan database Supabase dan ThingsBoard Cloud, bukan mode data palsu (`THINGSBOARD_MOCK=true`). Simulator berperan sebagai Raspberry Pi.

Siapkan **tiga terminal**: satu untuk backend, satu untuk simulator, satu untuk pemeriksa.

## Yang dibutuhkan

- Akun ThingsBoard Cloud dan akun Supabase (gratis cukup).
- Node.js 20 atau lebih baru, dan folder proyek yang sudah `npm install`.

## Langkah 1. Siapkan device simulasi di ThingsBoard

1. Masuk ke ThingsBoard, buka **Entities > Devices**, klik **+** lalu **Add new device**. Beri nama `tanova-simulator`, klik **Add**.
2. Klik device itu. Salin dua hal:
   - **Copy access token**: dipakai simulator.
   - **Copy device ID**: UUID yang dipakai backend.
3. Catat **region** akun Anda dari alamat di browser:

| Alamat di browser | `TB_URL` backend | `THINGSBOARD_HOST` simulator |
| --- | --- | --- |
| `thingsboard.cloud` | `https://thingsboard.cloud` | `mqtt.thingsboard.cloud` |
| `eu.thingsboard.cloud` | `https://eu.thingsboard.cloud` | `mqtt.eu.thingsboard.cloud` |

Region salah adalah penyebab paling sering "tidak tersambung".

## Langkah 2. Jalankan backend asli (terminal 1)

1. Pastikan `DATABASE_URL` sudah terisi (lihat `docs/PANDUAN-SUPABASE.md`) dan tiga kunci rahasia sudah dibuat (`npm run gen-secrets`).
2. Di `.env` set:

```
THINGSBOARD_MOCK=false
TB_URL=https://thingsboard.cloud
```

3. Jalankan:

```
npm run seed
npm run dev
```

4. Buka `http://localhost:3000/health`. Isinya harus mengandung `"thingsboard":"live"`. Jika masih `mock`, `THINGSBOARD_MOCK` belum `false` atau backend belum dijalankan ulang.

## Langkah 3. Jalankan simulator (terminal 2)

1. Salin `simulator/.env.example` menjadi `simulator/.env`, lalu isi:

```
THINGSBOARD_TOKEN=<access token dari langkah 1>
THINGSBOARD_HOST=mqtt.thingsboard.cloud
THINGSBOARD_INTERVAL=10
```

2. Jalankan `npm run simulator`.
3. Tanda berhasil: muncul `Terhubung ke ThingsBoard mqtt.thingsboard.cloud:1883`.
4. Di ThingsBoard, buka device `tanova-simulator` lalu tab **Latest telemetry**. Nilai `ph`, `ec`, `temp_water`, dan lainnya muncul dan berubah tiap beberapa detik.

Jika pesan yang muncul `Galat MQTT ... periksa THINGSBOARD_TOKEN`, token salah.

## Langkah 4. Hubungkan backend ke simulator

### Cara otomatis (disarankan), terminal 3

```
npm run check -- --device-id=<device ID> --tb-user=<email ThingsBoard> --tb-pass=<password ThingsBoard> --tb-url=https://thingsboard.cloud
```

Skrip ini menyimpan koneksi pada perangkat bernama `Simulator Test`, lalu menjalankan 13 pemeriksaan. Hasil yang diharapkan:

```
[OK]    Backend menjawab (/health)
[OK]    Login admin
[OK]    Tes koneksi ThingsBoard (login akun + cek Device ID)
[OK]    Menyimpan koneksi pada perangkat uji
[OK]    Status koneksi menjadi "connected"
[OK]    Dashboard menampilkan nilai sensor terkini (bukan basi)
[OK]    Ganti mode ke manual terbaca di dashboard
[OK]    Kontrol kipas ON lalu terbaca dari perangkat
[OK]    Dosis pH Up 5 detik menyala lalu mati sendiri
[OK]    Ubah pengaturan (target EC) dan terbaca kembali dari perangkat
[OK]    Pengaturan tidak valid ditolak
[OK]    Mode auto: kontrol manual ditolak
[OK]    Riwayat telemetri tersedia
Hasil: 13 berhasil, 0 gagal.
```

Jika ada yang `[GAGAL]`, pesannya menjelaskan penyebab dan petunjuknya.

### Cara manual lewat Swagger

1. Buka `http://localhost:3000/docs`. Klik `POST /auth/login`, isi `admin@tanova.local` dan `Admin12345!`, salin `access_token`, lalu klik **Authorize** dan tempel.
2. `POST /devices/connection/test` dengan `tb_device_id`, `tb_username`, `tb_password`, dan `tb_url`. Harus `ok: true`.
3. `POST /devices` dengan nama dan data koneksi yang sama untuk menyimpannya.
4. `GET /devices`. Pada perangkat itu, `connection.status` harus `connected`.

## Langkah 5. Skenario uji manual

| Yang dilakukan | Yang diharapkan | Terlihat di terminal simulator |
| --- | --- | --- |
| `PUT /devices/:id/mode` dengan `manual` | Dashboard menampilkan mode manual | `Mode sistem: manual` |
| `POST /actuators/:id/control` pada `fan` dengan `{"state":"on"}` | `device_response.ok = true`, kipas `on` di dashboard dalam beberapa detik | `RPC ... setActuator: OK` |
| Dosis `pump_ph_up` dengan `duration` 10, lalu langsung dosis `pump_ec_a` | Yang kedua ditolak 409 `DEVICE_REJECTED`. Pompa pertama mati sendiri setelah 10 detik | `pompa dosis lain sedang aktif` |
| `PUT /devices/:id/config` dengan `{"ec": 2.4}` | `applied: true`, lalu `GET /devices/:id/config` menampilkan 2.4 | `Pengaturan dari website diterapkan` |
| Mode `auto`, lalu kontrol aktuator | Ditolak 409 | `Mode sistem: auto` |
| Buat aturan peringatan pH di bawah 5.5, lalu ketik `set ph 4.8` di terminal simulator | Dalam sekitar 30 detik muncul notifikasi di `GET /alerts/notifications` | `ph diatur ke 4.8` |
| Ketik `sensor off` | Status `sensor_offline`, nilai sensor kosong | `Sensor offline` |
| Ketik `sensor on` | Status kembali `connected` | `Sensor online` |
| Hentikan simulator (Ctrl+C) | Status `offline` | |

## Masalah yang sering muncul

| Gejala | Penyebab | Perbaikan |
| --- | --- | --- |
| `/health` menampilkan `"thingsboard":"mock"` | `THINGSBOARD_MOCK` masih true | Set `false`, jalankan ulang backend |
| Tes koneksi tahap `login` | Email atau password ThingsBoard salah | Cek login langsung di web ThingsBoard |
| Tes koneksi tahap `device` | Device ID salah, atau akun tidak punya akses ke device itu | Salin ulang **device ID**, bukan access token |
| Tes koneksi tahap `network` | `TB_URL` salah atau beda region | Samakan dengan alamat di browser |
| Status `offline` padahal simulator jalan | Token di `simulator/.env` bukan milik device yang Device ID-nya dimasukkan | Pastikan token dan Device ID dari device yang sama |
| Status `connected` tetapi nilai kosong dan `stale: true` | Telemetri berhenti atau lebih tua dari `TELEMETRY_STALE_SECONDS` | Periksa simulator masih berjalan |
| Kontrol 504 | Perangkat tidak membalas RPC dalam 20 detik | Pastikan simulator berjalan, lalu coba lagi |
| Simulator `Galat MQTT` | Token salah, atau host MQTT beda region | Periksa `THINGSBOARD_TOKEN` dan `THINGSBOARD_HOST` |
| Pesan ThingsBoard berhenti masuk | Kuota pesan bulanan paket gratis habis | Naikkan `THINGSBOARD_INTERVAL` ke 30 atau lebih |

## Langkah 6. Mengganti simulator dengan service asli

1. Hentikan simulator. Jangan jalankan dua pengirim dengan token yang sama.
2. Jalankan service asli di Raspberry Pi dengan access token device yang sama (atau token device lain, lalu isi koneksi baru dengan Device ID-nya).
3. Jalankan lagi `npm run check` dengan parameter yang sama.
4. Langkah yang `[GAGAL]` menunjukkan bagian service yang belum sesuai kontrak (`docs/KONTRAK-SERVICE.md`). Perbaiki service-nya, bukan backend.

## Membersihkan setelah uji

- Hapus perangkat uji dengan `DELETE /devices/:id` (akun admin), atau biarkan.
- Hapus device `tanova-simulator` di ThingsBoard bila tidak dipakai lagi, agar data buatan tidak tercampur dengan data asli.
