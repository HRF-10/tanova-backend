# Tanova App Backend dan Service Raspberry Pi

Paket ini berisi dua bagian yang saling terhubung:

- **Backend** (folder `src`): API Fastify yang dipakai frontend Vue.
- **Service Raspberry Pi** (folder `raspi`): `service_1.py` yang sudah diperiksa dan diperbaiki, mengirim data ke ThingsBoard dan menerima perintah dari website.

## 1. Gambaran sistem

```
Aplikasi (frontend) <--REST/SSE--> Backend Fastify <--REST API--> ThingsBoard <--MQTT--> Raspberry Pi (service_1.py)
        |                              |                                                  |-- Redis (keadaan terakhir)
        |                              +-- MySQL                                          |-- Mosquitto lokal -> Wemos (kontrol relay) dan sensor
        +-- Proses AI (di aplikasi)
        +-- Kamera ESP32-S3 CAM (terpisah dari Raspberry Pi)
```

- **Data sensor** mengalir ke kiri: sensor, Raspberry Pi, ThingsBoard, backend, aplikasi.
- **Perintah dan pengaturan** mengalir ke kanan: aplikasi, backend, ThingsBoard, Raspberry Pi, Wemos, relay.
- Backend tidak bicara langsung dengan Raspberry Pi. Semuanya lewat ThingsBoard, jadi alat boleh berada di jaringan mana pun.
- **Akun dan Device ID ThingsBoard diisi pengguna sendiri dari GUI aplikasi** (per perangkat), bukan di file `.env` backend.
- **Saat ini service asli belum dipakai.** Peran Raspberry Pi digantikan oleh **simulator** (folder `simulator`) yang mengikuti kontrak di `docs/KONTRAK-SERVICE.md`. Backend tidak berubah saat service asli nanti dipasang, yang disesuaikan adalah service-nya.
- **Pemrosesan AI dilakukan di aplikasi.** Backend hanya menyimpan hasil diagnosis dan foto. Kamera ESP32-S3 CAM tidak ada di `service_1.py`.

Ada dua jenis alamat ThingsBoard yang berbeda, dan ini sering tertukar:

- `THINGSBOARD_HOST` di `raspi/.env` adalah alamat **MQTT** (contoh `mqtt.thingsboard.cloud`).
- URL di backend adalah alamat **web/REST** (contoh `https://thingsboard.cloud`).

## 2. Isi folder

```
src/                  kode backend (Fastify)
src/config/contract.js       kontrak backend dan service (RPC, atribut, batas pengaturan)
simulator/            simulator service (pengganti Raspberry Pi untuk uji)
tools/                ThingsBoard tiruan untuk uji tanpa internet (opsional)
docs/PANDUAN-ENV.md          panduan mengisi file .env, termasuk penjelasan JWT
docs/KONTRAK-SERVICE.md      aturan yang harus dipenuhi service
raspi/                service_1.py asli (belum dipakai) beserta catatan perbaikannya
.env.example          contoh pengaturan backend
```

## 3. Langkah pemasangan

### Langkah 1. Siapkan ThingsBoard

1. Masuk ke ThingsBoard, buka **Entities > Devices**, lalu **Add device** (atau pakai device yang sudah ada).
2. Buka device tersebut dan salin dua hal:
   - **Access token** (Copy access token). Ini **hanya untuk Raspberry Pi** (`THINGSBOARD_TOKEN` di `raspi/.env`). Backend tidak memakainya.
   - **Device ID** berbentuk UUID (Copy device ID). Ini diisi pengguna di GUI aplikasi.
3. Pengguna aplikasi juga memasukkan **email dan password akun ThingsBoard** yang punya akses ke device itu (akun Tenant, atau akun Customer yang device-nya sudah di-assign).

Kenapa bukan access token device? Access token device hanya boleh dipakai oleh perangkat itu sendiri untuk mengirim data. Token itu **tidak bisa** membaca riwayat telemetri dan **tidak bisa** mengirim perintah ke perangkat. Dua hal itu hanya bisa dilakukan lewat akun ThingsBoard.

### Langkah 2. Pasang service di Raspberry Pi

```bash
cd ~/tanova                       # folder tempat service_1.py berada
pip install -r requirements.txt   # redis, python-dotenv, paho-mqtt
cp .env.example .env              # lalu isi CLIENT_ID dan THINGSBOARD_TOKEN
python3 service_1.py              # coba jalan manual dulu
```

Yang wajib diisi di `raspi/.env`:

- `CLIENT_ID` memakai UUID lama dari sistem sebelumnya. Nilainya dipakai menyusun topik MQTT lokal dan harus sama dengan yang dipakai Wemos dan program lain di Raspberry Pi.
- `THINGSBOARD_TOKEN` adalah access token dari Langkah 1.
- `THINGSBOARD_HOST` adalah alamat MQTT ThingsBoard.

Broker untuk Wemos (sensor dan relay) bisa dipilih lewat `.env`. Firmware Wemos belum diketahui, jadi cari tahu dulu ke broker mana ia menyambung:

- **Pilihan A, mosquitto lokal di Raspberry Pi** (bawaan): `LOCAL_MQTT_BROKER=localhost`, port 1883.
- **Pilihan B, broker online sistem lama**: isi `MQTT_BROKER`, `MQTT_PORT=8883`, `MQTT_USERNAME`, `MQTT_PASSWORD`. Nama variabelnya sama dengan `.env` sistem lama. Port 8883 otomatis memakai TLS.

Cara mengetes broker lama sebelum memakainya (jalankan di Raspberry Pi):

```bash
mosquitto_sub -h 70-mqtt.oemahsolution.com -p 8883 --cafile /etc/ssl/certs/ca-certificates.crt \
  -u USER-LAMA -P 'PASSWORD-LAMA' -t '#' -v
```

- Jika perintah gagal tersambung atau timeout, server lama kemungkinan sudah tidak aktif. Tambahkan `--insecure` bila pesannya soal sertifikat.
- Jika tersambung, nyalakan Wemos dan perhatikan apakah muncul pesan dengan topik berawalan `3222d34f-05fa-4b44-bb83-632feae63a9d/`. Jika muncul, Wemos memang menyambung ke broker lama, jadi pakai Pilihan B.
- Lakukan hal yang sama di mosquitto lokal (`mosquitto_sub -h localhost -u smartfarm -P 'smartfarm*2023' -t '#' -v`). Broker yang menerima pesan dari Wemos adalah broker yang harus dipakai.
- Jika di kedua broker tidak ada pesan dari Wemos, Wemos mati atau WiFi/alamat broker di firmware sudah tidak cocok. Itu hanya bisa diperbaiki dari sisi firmware Wemos.

Tanda berhasil di log:

- `ThingsBoard: terhubung ke ...` berarti Raspberry Pi sudah tersambung.
- Di ThingsBoard, tab **Latest telemetry** pada device mulai berisi `ph`, `ec`, `temp_water`, dan seterusnya.

Agar jalan otomatis saat Raspberry Pi menyala, buat `/etc/systemd/system/tanova.service` (sesuaikan user dan path):

```ini
[Unit]
Description=Tanova service_1
After=network-online.target mosquitto.service redis-server.service
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/tanova
ExecStart=/usr/bin/python3 service_1.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Lalu jalankan `sudo systemctl enable --now tanova` dan lihat log dengan `journalctl -u tanova -f`.

### Langkah 3. Siapkan MySQL

Pasang MySQL atau MariaDB (di Windows bisa lewat XAMPP atau MySQL Installer). Lalu buat database dan user:

```sql
CREATE DATABASE tanova CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'tanova'@'localhost' IDENTIFIED BY 'password-anda';
GRANT ALL ON tanova.* TO 'tanova'@'localhost';
```

Jika Anda langsung memakai user `root`, database dibuat otomatis saat backend pertama kali jalan (`DB_AUTO_CREATE=true`). Tabel selalu dibuat otomatis lewat migrasi.

### Langkah 4. Jalankan backend

Butuh Node.js 20 atau lebih baru.

```bash
npm install
cp .env.example .env     # isi DB_USER dan DB_PASSWORD
npm run gen-secrets      # cetak tiga kunci rahasia, tempel ke .env (lihat docs/PANDUAN-ENV.md)
npm run seed             # membuat admin dan data contoh
npm run dev              # atau: npm start
```

- Dokumentasi interaktif semua endpoint: `http://localhost:3000/docs`
- Login admin hasil seed: `admin@tanova.local` dengan password `Admin12345!`. Segera ganti.
- Secara bawaan backend memakai **data simulasi** (`THINGSBOARD_MOCK=true`), jadi frontend bisa dikembangkan tanpa alat.
- Untuk ThingsBoard asli, set `THINGSBOARD_MOCK=false`.

### Langkah 5. Sambungkan perangkat dari GUI

Alurnya yang harus dibuat di aplikasi:

1. Pengguna membuka form koneksi perangkat dan mengisi URL ThingsBoard (boleh kosong untuk memakai bawaan), email dan password ThingsBoard, serta Device ID.
2. Tombol **Tes koneksi** memanggil `POST /api/v1/devices/connection/test`. Hasilnya `ok: true` atau `ok: false` dengan `stage` (`network`, `login`, atau `device`) dan pesan.
3. Tombol **Simpan** memanggil `POST /api/v1/devices` (perangkat baru) atau `PUT /api/v1/devices/:id/connection` (perangkat yang sudah ada).
4. Buka `GET /api/v1/dashboard/overview`. Jika `online: true` dan nilai sensor terisi, semuanya sudah tersambung.

Password ThingsBoard disimpan **terenkripsi** (AES-256-GCM) dan tidak pernah dikembalikan oleh API. Respons hanya berisi `tb_connection` dengan `username`, `device_id`, `has_password`, dan `configured`.

#### Status koneksi untuk badge di dashboard

Setiap perangkat punya objek `connection` pada `GET /devices`, `GET /devices/:id`, dan `GET /dashboard/overview`:

| `connection.status` | Arti | Teks yang bisa ditampilkan |
| --- | --- | --- |
| `connected` | Raspberry Pi dan sensor terhubung | Terhubung |
| `sensor_offline` | Raspberry Pi terhubung, sensor tidak mengirim data | Terhubung, sensor tidak mengirim data |
| `offline` | Raspberry Pi tidak terhubung ke ThingsBoard | Perangkat offline |
| `error` | Backend gagal ke ThingsBoard (akun, URL, atau Device ID salah) | Gagal terhubung, tampilkan `message` |
| `not_configured` | Device ID atau akun belum diisi | Belum diatur |

Objek itu juga berisi `message`, `online`, `sensor_online`, dan `last_seen`. Status `connected` berarti Raspberry Pi sedang tersambung ke ThingsBoard lewat access token di `raspi/.env`. Itulah yang membuat Device ID di setting koneksi tampil sebagai terhubung.

### Langkah 6. Uji tanpa alat dengan simulator

Simulator berperan sebagai Raspberry Pi: terhubung ke ThingsBoard lewat MQTT, mengirim telemetri, menerima perintah, dan membalas persis seperti kontrak. Nama variabel `.env`-nya sama dengan service asli.

**Opsi 1. Dengan ThingsBoard sungguhan**

1. Di ThingsBoard buat device baru khusus simulasi (jangan pakai device milik Raspberry Pi sungguhan). Salin access token dan Device ID-nya.
2. `cp simulator/.env.example simulator/.env`, lalu isi `THINGSBOARD_TOKEN`.
3. Jalankan `npm run simulator`. Di ThingsBoard, tab Latest telemetry device itu mulai terisi.
4. Backend: set `THINGSBOARD_MOCK=false` dan `TB_URL=https://thingsboard.cloud`, jalankan ulang.
5. Di dashboard, isi setting koneksi dengan Device ID dan akun ThingsBoard. Status harus berubah menjadi Terhubung.

**Opsi 2. Tanpa internet (ThingsBoard tiruan)**

1. Di `simulator/.env` isi `THINGSBOARD_HOST=localhost` dan `THINGSBOARD_TOKEN=SIMTOKEN`.
2. Terminal 1: `npm run fake-tb`
3. Terminal 2: `npm run simulator`

Di `.env` backend isi `THINGSBOARD_MOCK=false` dan `TB_URL=http://localhost:8099`. Di setting koneksi dashboard isi email `tenant@thingsboard.org`, password `tenant`, dan Device ID `11111111-2222-3333-4444-555555555555`.

**Skenario yang bisa dicoba**

- Ganti mode manual dan auto, lalu nyalakan kipas. Statusnya berubah di dashboard dalam beberapa detik.
- Nyalakan pompa dosis dengan `duration` 10. Pompa mati sendiri. Nyalakan dua pompa dosis bersamaan, yang kedua ditolak dengan 409.
- Ubah pengaturan lewat `PUT /devices/:id/config`, lalu baca lagi lewat `GET /devices/:id/config`.
- Ketik `set ph 4.8` di terminal simulator untuk memicu peringatan pH rendah.
- Ketik `sensor off` untuk melihat status `sensor_offline` dan nilai sensor menjadi kosong. Ketik `sensor on` untuk memulihkan.
- Hentikan simulator untuk melihat status `offline`.

Perintah terminal simulator: `status`, `set <kunci> <nilai>`, `sensor on|off`, `help`, `quit`.

**Saat service asli siap dipakai**

Hentikan simulator, jalankan service asli dengan access token device yang sama, dan **tidak ada kode backend yang diubah**. Jika ada perilaku yang berbeda, service-nya yang disesuaikan mengikuti `docs/KONTRAK-SERVICE.md`.

## 4. Cara kerja per fitur

### Data sensor

Raspberry Pi mengirim telemetri tiap 10 detik. Backend membacanya dan memberi label status (normal, warning, critical).

| Metrik di API | Key di ThingsBoard | Keterangan |
| --- | --- | --- |
| `ph` | `ph` | |
| `ec` | `ec` | mS/cm |
| `tds` | tidak dikirim | dihitung dari EC dikali `TDS_FACTOR` (bawaan 500) |
| `water_temp` | `temp_water` | suhu air |
| `air_temp` | `temp_air` | suhu udara |
| `humidity` | `humidity` | kelembapan |
| `waterflow` | `waterflow` | aliran air |
| `tank_level` | `tank_level` | **belum ada sensornya**, nilainya kosong (`unknown`) |

Status relay (`pump_ec_a`, `pump_a`, `fan`, dan lainnya) juga dikirim sebagai telemetri, jadi dashboard menampilkan keadaan relay yang sebenarnya, termasuk pompa dosis yang mati sendiri setelah waktunya habis.

### Mode sistem (otomatis atau manual)

- `PUT /api/v1/devices/:id/mode` dengan `{"mode": "manual"}` atau `{"mode": "auto"}`.
- Disimpan sebagai shared attribute `mode`, jadi tetap berlaku walau Raspberry Pi sedang mati lalu menyala lagi.
- Saat pindah ke manual, semua aktuator (kecuali pompa utama) dimatikan oleh Raspberry Pi demi keamanan.

### Kontrol aktuator (hanya saat mode manual)

`POST /api/v1/actuators/:id/control`

```json
{ "state": "on", "duration": 30 }
```

- `state` adalah `on` atau `off`.
- `duration` (detik) hanya untuk pompa dosis (`pump_ec_a`, `pump_ec_b`, `pump_ph_up`, `pump_ph_down`). Jika kosong, dipakai durasi dari pengaturan perangkat. Batasnya `MANUAL_MAX_DURATION` (bawaan 300).
- Backend mengirim RPC `setActuator` dengan params `{"actuator": "<control_key>", "state": true, "duration": 30}` lalu menunggu balasan Raspberry Pi.
- Jika Raspberry Pi menolak (misalnya pompa dosis lain sedang aktif), backend menjawab `409` dengan kode `DEVICE_REJECTED` dan alasan dari perangkat.
- Pompa utama A dan B tidak boleh menyala bersamaan. Menyalakan satu otomatis memindahkan dari yang lain.

Daftar `control_key` yang dikenal service: `pump_ec_a`, `pump_ec_b`, `pump_ph_up`, `pump_ph_down`, `pump_a`, `pump_b`, `fan`, `heater`. Delapan aktuator ini dibuat otomatis saat perangkat didaftarkan.

### Pengaturan kendali otomatis

- `GET /api/v1/devices/:id/config` menampilkan pengaturan yang **berlaku di perangkat** beserta `config_errors` bila ada nilai yang ditolak.
- `PUT /api/v1/devices/:id/config` mengubah pengaturan. Kirim sebagian field saja.

| Field | Arti |
| --- | --- |
| `ec_mode` | `all` target EC tetap, `single` target EC mengikuti daftar harian `dap` |
| `ec` | target EC (0 sampai 20) |
| `ph_down` dan `ph_up` | batas bawah dan atas pH. `ph_down` harus lebih kecil dari `ph_up` |
| `fan_air_temp_min` dan `fan_air_temp_max` | pemanas menyala di bawah batas min, kipas menyala di atas batas max |
| `fan_humidity` | kipas menyala bila kelembapan di atas nilai ini |
| `peristaltic_pump_duration` | lama satu dosis (detik) |
| `peristaltic_pump_period` | jeda antar dosis |
| `waterflow` | ambang aliran air untuk menukar pompa utama |
| `dap` dan `start_dap` | target EC per hari setelah tanam dan tanggal tanam |

Backend memeriksa batas yang sama dengan perangkat, mengirim lewat RPC `setConfig` (hasil langsung), lalu menyimpannya sebagai shared attribute agar tetap berlaku saat Raspberry Pi restart. Jika perangkat sedang offline, pengaturan tetap disimpan dan jawabannya `pending: true`.

### Peringatan

Backend mengecek aturan ambang batas tiap `ALERT_CHECK_INTERVAL_SEC` detik. Jika terpicu (dan lewat masa tunggu `cooldown_minutes`), peringatan tersimpan sebagai **notifikasi di aplikasi**.

- Pengiriman lewat WhatsApp, Telegram, dan email **dihapus sementara**. Hanya notifikasi di aplikasi yang aktif.
- Aturan dibuat lewat `POST /alerts/rules` dengan `metric`, `operator`, `threshold`, `severity`, dan `cooldown_minutes`.
- Metrik yang bisa dipakai: `ph`, `ec`, `tds`, `water_temp`, `air_temp`, `humidity`, `waterflow`, `tank_level`.
- Aplikasi membaca notifikasi lewat `GET /alerts/notifications` dan jumlah yang belum dibaca lewat `/alerts/notifications/unread-count`.

### Tanova AI

Pemrosesan AI dilakukan di **sisi aplikasi**. Backend tidak menjalankan model dan tidak menerima kiriman dari Raspberry Pi atau layanan lain tanpa login.

- Aplikasi mengirim hasil diagnosis ke `POST /ai/diagnoses` memakai login pengguna. Bisa JSON, atau multipart dengan field `image` untuk foto (JPEG, PNG, WebP, maksimal 5 MB).
- Kamera ESP32-S3 CAM terpisah dari Raspberry Pi. Cara aplikasi mengambil foto dari kamera itu berada di sisi aplikasi.
- Jika `recommendation` kosong, dibuat dari label lewat aturan di `src/services/recommendations.js`.
- Diagnosis dengan `severity: "high"` otomatis membuat notifikasi di aplikasi.
- Data pertumbuhan dikirim ke `POST /ai/growth`. Prediksi kesehatan saat ini regresi linear sederhana dari skor kesehatan historis.

## 5. Contoh pemakaian (curl)

```bash
B=http://localhost:3000/api/v1

# login
TOKEN=$(curl -s -X POST $B/auth/login -H 'content-type: application/json' \
  -d '{"email":"admin@tanova.local","password":"Admin12345!"}' | jq -r .access_token)

# daftarkan perangkat beserta koneksi ThingsBoard (aktuator dan sensor bawaan dibuat otomatis)
curl -X POST $B/devices -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"name":"Tanova Grove 01","zone":"Zona A","tb_device_id":"UUID-DEVICE","tb_username":"email@thingsboard","tb_password":"password-thingsboard"}'

# dashboard
curl $B/dashboard/overview -H "authorization: Bearer $TOKEN"

# pindah ke manual lalu nyalakan kipas
curl -X PUT $B/devices/ID_PERANGKAT/mode -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"mode":"manual"}'
curl -X POST $B/actuators/ID_AKTUATOR/control -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"state":"on"}'

# ubah target EC
curl -X PUT $B/devices/ID_PERANGKAT/config -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"ec":2.8}'
```

Semua field JSON memakai `snake_case`. Format error seragam: `{ "statusCode": 409, "code": "MODE_NOT_MANUAL", "message": "..." }`.

## 6. Daftar endpoint (`/api/v1`)

| Modul | Endpoint |
| --- | --- |
| Auth | `POST /auth/register`, `/auth/login`, `/auth/refresh`, `/auth/change-password` |
| Profil | `GET/PATCH /users/me`, `PUT /users/me/greenhouse`, admin: `GET /users`, `PATCH /users/:id` |
| Dashboard | `GET /dashboard/overview`, `GET /dashboard/stream` (SSE, token lewat `?token=`) |
| Aktuator | `GET /actuators`, `POST /actuators/:id/control` |
| Koneksi ThingsBoard | `POST /devices/connection/test`, `POST /devices/:id/connection/test`, `PUT /devices/:id/connection` |
| Mode dan pengaturan | `PUT /devices/:id/mode`, `GET/PUT /devices/:id/config` |
| Kalibrasi | `GET /calibrations`, `GET/POST /sensors/:id/calibrations` |
| Telemetri | `GET /telemetry/history`, `GET /telemetry/export` (CSV) |
| Log aktivitas | `GET /activity-logs`, `GET /activity-logs/export` (CSV) |
| Perangkat | `GET /devices/summary`, `GET/POST /devices`, `GET/PATCH/DELETE /devices/:id`, CRUD sensor dan aktuator |
| Peringatan | `GET/POST /alerts/rules`, `PATCH/DELETE /alerts/rules/:id`, `GET /alerts/notifications`, `GET /alerts/notifications/unread-count`, `PATCH /alerts/notifications/:id/read`, `POST /alerts/notifications/read-all` |
| Tanova AI | `GET/POST /ai/diagnoses`, `GET /ai/diagnoses/:id`, `PATCH /ai/diagnoses/:id/action`, `GET /ai/recommendations`, `GET/POST /ai/growth`, `GET /ai/prediction` |

Peran pengguna: `admin` (semua akses), `operator` (kontrol dan kelola greenhouse miliknya), `viewer` (hanya melihat). Registrasi selalu membuat `operator`. Data dipisah per greenhouse.

## 7. Jika ada masalah

- **`online: false` padahal Raspberry Pi menyala**: periksa `THINGSBOARD_TOKEN` di `raspi/.env`, dan lihat apakah device di ThingsBoard berstatus Active.
- **`telemetry_error` berisi "Akun ThingsBoard ... belum diisi"**: perangkat belum punya email dan password ThingsBoard. Isi lewat `PUT /devices/:id/connection`.
- **`telemetry_error` berisi "Email atau password ThingsBoard salah"**: pakai tombol Tes koneksi untuk memeriksa akun.
- **`telemetry_error` berisi "Tidak dapat terhubung ke ThingsBoard"**: periksa URL ThingsBoard (alamat web, bukan MQTT).
- **Tes koneksi `stage: device`**: Device ID salah, atau akun tidak punya akses ke device itu.
- **Password ThingsBoard tersimpan tidak terbaca setelah `CREDENTIAL_ENCRYPTION_KEY` diganti**: kunci itu tidak boleh diubah. Jika terlanjur, pengguna perlu mengisi ulang password.
- **Dashboard hidup tetapi semua nilai kosong**: key telemetri tidak cocok. Cocokkan `TB_KEY_*` dengan key yang tampil di Latest telemetry.
- **Kontrol aktuator gagal 504**: Raspberry Pi offline atau terlalu sibuk. Perintah diproses berurutan dan tiap perintah ke relay menunggu 2 detik. Pindah mode ke manual bisa memakan sekitar 12 detik.
- **Kontrol gagal 409 `DEVICE_REJECTED`**: baca pesan alasannya. Penyebab umum: mode masih otomatis, atau pompa dosis lain sedang aktif.
- **`sensor_online: false`**: ESP sensor tidak mengirim data ke Raspberry Pi lebih dari 10 detik. Pada mode otomatis, service mematikan semua relay (kecuali pompa A) demi keamanan.
- **Pengaturan tidak berubah**: lihat `config_errors` pada `GET /devices/:id/config`.

## 8. Status pengujian

- Alur lengkap diuji dengan simulator dan ThingsBoard tiruan di atas MariaDB: tes koneksi, status koneksi, kontrol kipas dan dosis, penolakan dosis ganda, mode, pengaturan, peringatan, sensor putus, dan simulator dimatikan.
- Backend diuji di atas MariaDB (kompatibel dengan MySQL) dengan data simulasi, dan dengan ThingsBoard tiruan yang meniru kontrak `service_1.py` (telemetri, RPC `setActuator` dan `setConfig`, balasan ditolak, perangkat offline, akun benar dan salah).
- `raspi/service_1.py` baru diperiksa sintaks dan logikanya dibaca ulang. **Belum dijalankan di Raspberry Pi dan relay sungguhan.** Uji dulu dengan beban relay yang aman sebelum dipakai pada pompa.
- Belum diuji dengan ThingsBoard, Wemos, dan Raspberry Pi sungguhan.

## 9. Catatan produksi

- Ganti `JWT_SECRET`, `JWT_REFRESH_SECRET`, password admin, dan batasi `CORS_ORIGIN` ke domain frontend.
- Folder `/uploads` disajikan publik dengan nama file acak. Pindahkan ke object storage bila foto sensitif.
- Jalankan di belakang reverse proxy HTTPS (Nginx atau Caddy).
- Ganti `CREDENTIAL_ENCRYPTION_KEY` sebelum ada pengguna yang menyimpan koneksi, dan simpan kuncinya dengan aman.
- Backup database MySQL secara berkala. Tabel `devices` berisi password ThingsBoard terenkripsi.
