# Kontrak antara backend dan service

Dokumen ini adalah satu-satunya acuan untuk service (Raspberry Pi atau simulator). **Backend tidak diubah saat service diganti. Service yang menyesuaikan diri dengan kontrak ini.** Simulator di folder `simulator` sudah memenuhi seluruh kontrak, jadi bisa dipakai sebagai contoh dan pembanding.

Isi kontrak dalam bentuk kode ada di `src/config/contract.js`. Bila suatu saat kontrak memang harus diubah, itu satu-satunya file backend yang disentuh.

## 1. Koneksi

- Service terhubung ke ThingsBoard lewat MQTT memakai **access token** device sebagai username (tanpa password).
- Service berlangganan tiga topik: `v1/devices/me/rpc/request/+`, `v1/devices/me/attributes`, dan `v1/devices/me/attributes/response/+`.
- Saat menyala, service meminta atribut shared dengan publish ke `v1/devices/me/attributes/request/1` berisi `{"sharedKeys": "mode,ec,ph_down,..."}` lalu menerapkan jawabannya.

## 2. Telemetri (publish ke `v1/devices/me/telemetry`)

Dikirim berkala (disarankan tiap 10 detik) dan segera setelah ada perubahan. Format `{"ts": <epoch ms>, "values": {...}}`.

| Key | Tipe | Keterangan |
| --- | --- | --- |
| `ph` | angka | pH |
| `ec` | angka | EC dalam mS/cm |
| `temp_water` | angka | suhu air (°C) |
| `temp_air` | angka | suhu udara (°C) |
| `humidity` | angka | kelembapan (%) |
| `waterflow` | angka | aliran air |
| `pump_ec_a`, `pump_ec_b`, `pump_ph_up`, `pump_ph_down`, `pump_a`, `pump_b`, `fan`, `heater` | boolean | keadaan relay yang sebenarnya |
| `sensor_online` | boolean | `false` bila sensor berhenti mengirim data ke service |
| `mode` | teks | `auto` atau `manual`, mode yang berlaku di perangkat |

Aturan:

- Saat sensor offline, **jangan kirim nilai sensor** (jangan kirim 0). Cukup kirim status relay, `sensor_online: false`, dan `mode`.
- Interval kirim harus jauh di bawah `TELEMETRY_STALE_SECONDS` (bawaan 120 detik), karena data yang lebih tua dianggap basi.
- `tds` tidak perlu dikirim. Backend menghitungnya dari EC.
- Nama key bisa diganti tanpa mengubah kode lewat `TB_KEY_*` di `.env` backend.

## 3. Atribut klien (publish ke `v1/devices/me/attributes`)

Berisi pengaturan yang **benar-benar berlaku** di perangkat. Aplikasi membacanya lewat `GET /devices/:id/config`.

- Semua key pengaturan pada bagian 5, ditambah `is_active`.
- `mode`: `auto` atau `manual`.
- `config_errors`: objek `{ "<key>": "<alasan>" }` untuk nilai terakhir yang ditolak. Objek kosong berarti semua diterima.

## 4. Atribut shared (dari backend ke service)

- `mode` (`manual` atau `auto`) ditulis backend saat pengguna mengganti mode.
- Key pengaturan pada bagian 5 juga ditulis sebagai shared attribute agar tetap berlaku saat service restart.
- Service menerimanya di topik `v1/devices/me/attributes` (perubahan langsung, bentuk `{"mode": "auto"}`) dan di `v1/devices/me/attributes/response/+` (jawaban permintaan awal, bentuk `{"shared": {...}}`).
- Key yang tidak dikenal harus diabaikan.

## 5. Pengaturan kendali

Batas nilai harus sama dengan validasi di backend (`CONFIG_PROPS` pada `contract.js`).

| Key | Rentang | Arti |
| --- | --- | --- |
| `ec_mode` | `all` atau `single` | target EC tetap, atau mengikuti `dap` |
| `ec` | 0 sampai 20 | target EC |
| `ph_down`, `ph_up` | 0 sampai 14 | batas pH. `ph_down` harus lebih kecil dari `ph_up` |
| `fan_air_temp_min`, `fan_air_temp_max` | -20 sampai 100 | pemanas dan kipas. min harus lebih kecil dari max |
| `fan_humidity` | 0 sampai 100 | kipas menyala di atas nilai ini |
| `peristaltic_pump_duration` | 1 sampai 600 | lama satu dosis (detik) |
| `peristaltic_pump_period` | 0 sampai 1440 | jeda antar dosis |
| `waterflow` | 0 sampai 1000 | ambang penukar pompa utama |
| `dap` | daftar angka 0 sampai 20, maks 400 | target EC per hari |
| `start_dap` | `YYYY-MM-DD HH:MM:SS` | tanggal tanam |

## 6. RPC (request di `v1/devices/me/rpc/request/<id>`, balasan di `v1/devices/me/rpc/response/<id>`)

**Service wajib selalu membalas** dengan objek `{"ok": true|false, ...}`. Jika `ok` bernilai `false`, sertakan `error` (teks) atau `rejected` (objek alasan per key). Backend meneruskannya ke aplikasi sebagai galat 409 `DEVICE_REJECTED`.

### `setActuator`

Params: `{"actuator": "<control_key>", "state": true|false, "duration": <detik, opsional>}`

- Hanya boleh dilakukan saat mode `manual`. Saat `auto`, balas `ok: false`.
- `control_key` yang dikenal: `pump_ec_a`, `pump_ec_b`, `pump_ph_up`, `pump_ph_down`, `pump_a`, `pump_b`, `fan`, `heater`.
- `state` harus boolean.
- Pompa dosis (`pump_ec_a`, `pump_ec_b`, `pump_ph_up`, `pump_ph_down`):
  - Hanya satu yang boleh aktif pada satu waktu.
  - Mati sendiri setelah `duration` detik. Jika `duration` kosong, pakai `peristaltic_pump_duration`.
  - `duration` harus 1 sampai `MANUAL_MAX_DURATION`.
- `pump_a` dan `pump_b` tidak boleh menyala bersamaan. Menyalakan satu memindahkan dari yang lain.
- Balasan sukses: `{"ok": true, "actuator": "...", "state": true}`

### `setConfig`

Params: objek berisi sebagian atau semua key pada bagian 5.

- Nilai tidak valid ditolak dan tidak mengubah apa pun. Alasannya dilaporkan di `config_errors` dan di balasan.
- Balasan: `{"ok": true|false, "applied": {...}, "rejected": {...}, "unknown": [...]}`

### Opsional

- `setMode` dengan params `{"mode": "auto"|"manual"}`. Mode juga bisa lewat atribut shared.
- `getState` mengembalikan `{"ok": true, "mode", "sensor_online", "status", "values", "config"}`. Berguna untuk membandingkan service dengan simulator.
- `calibrate` belum dipakai service asli. Jika tidak didukung, balas `ok: false` dengan `error`.

## 7. Perilaku yang diharapkan

- Pindah ke `manual`: kendali otomatis berhenti, semua pompa dosis, kipas, dan pemanas dimatikan.
- Pindah ke `auto`: kendali otomatis lanjut. Jika kedua pompa utama mati, pompa A dinyalakan.
- Sensor offline pada mode `auto`: semua relay dimatikan kecuali pompa utama A.
- Perintah dari backend yang ditolak harus dibalas, bukan didiamkan.

## 8. Yang bisa disesuaikan tanpa mengubah kode backend

| Hal | Cara |
| --- | --- |
| Nama key telemetri | `TB_KEY_*` di `.env` backend |
| Daftar aktuator dan `control_key` | Diatur per perangkat dari GUI atau API (`/devices/:id/actuators`) |
| Interval telemetri | Di service |
| Batas durasi dosis manual | `MANUAL_MAX_DURATION` di service dan backend |

## 9. Cara memeriksa service baru

1. Jalankan simulator dan service baru bergantian pada device ThingsBoard uji yang sama (jangan bersamaan).
2. Dengan GUI atau Swagger, jalankan skenario yang sama: tes koneksi, ganti mode, kontrol kipas, kontrol dosis, ubah pengaturan, putuskan sensor.
3. Bandingkan hasilnya. Jika berbeda, service-lah yang diperbaiki. Panggil RPC `getState` ke kedua pihak untuk membandingkan keadaannya.
