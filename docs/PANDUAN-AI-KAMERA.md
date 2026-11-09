# Tanova AI: foto dianalisis melalui API Tanova AI eksternal

```text
FE / ESP32-S3 CAM --foto--> POST /api/v1/ai/analyze (Fastify)
                                  |
                                  +--> https://tanovaai.onrender.com/api/analyze
                                  |
                                  +--> simpan foto + diagnosis ke Supabase / database Tanova
```

Fastify Tanova bertindak sebagai perantara. Frontend dan ESP32 tetap memanggil endpoint Tanova sendiri; keduanya tidak perlu mengetahui URL layanan analisis eksternal maupun API key eksternalnya.

## 1. Environment backend

Tambahkan ke `.env`:

```env
IMAGE_API_URL=https://tanovaai.onrender.com
IMAGE_API_KEY=
IMAGE_API_TIMEOUT_MS=90000
CAMERA_API_KEY=<string acak panjang untuk autentikasi ESP32 ke backend Tanova>
UPLOAD_DIR=./uploads
MAX_UPLOAD_MB=5
```

`IMAGE_API_KEY` adalah key milik layanan analisis eksternal (header `x-api-key`), bukan Google AI Studio API Key. Dokumentasi OpenAPI layanan menandai header tersebut optional. Jika kosong, Fastify tidak mengirim header itu.

`CAMERA_API_KEY` berbeda: ini tetap digunakan untuk mengautentikasi ESP32 ke backend Tanova. Jangan samakan kedua key tersebut kecuali memang sengaja.

## 2. Endpoint Tanova yang dipakai FE / ESP32

`POST /api/v1/ai/analyze`

- Aplikasi: kirim Bearer JWT pengguna dengan role admin/operator.
- ESP32: kirim `x-api-key: CAMERA_API_KEY` dan `device_id`.
- Body: `multipart/form-data`, field file bernama `image`; atau body mentah JPEG/PNG/WebP sesuai dukungan route.

Fastify meneruskan file ke `POST https://tanovaai.onrender.com/api/analyze` sebagai `multipart/form-data` dengan field `image`. Jangan mengatur `Content-Type` multipart secara manual; boundary dibuat otomatis oleh runtime.

## 3. Response dan penyimpanan

Layanan eksternal mengembalikan `status`, `plant`, `problem`, `confidence`, `text`, dan `image_url`. Adapter `src/services/tanovaAi.js` memetakan data tersebut ke struktur diagnosis Tanova:

- `status` menjadi `category`.
- `problem` menjadi `label`.
- `confidence` skala 0-100 menjadi skala 0-1 di database.
- bagian `Gejala` dan `Rekomendasi` pada `text` diuraikan menjadi daftar.
- `image_url` eksternal dipakai sebagai fallback jika penyimpanan foto lokal/Supabase Tanova gagal.

API eksternal saat ini tidak mengirim severity terstruktur. Karena itu Tanova memakai `none` untuk status healthy dan `medium` untuk status bermasalah. Tinjau aturan ini jika layanan eksternal kelak menyediakan severity.

Tanova tetap menyimpan diagnosis ke tabel `ai_diagnoses`; riwayat FE tetap menggunakan `GET /api/v1/ai/diagnoses`, bukan perlu memanggil `/api/logs` eksternal.

## 4. Uji

```bash
curl -X POST "http://localhost:3000/api/v1/ai/analyze?device_id=<ID_PERANGKAT_TANOVA>" \
  -H "Authorization: Bearer <JWT>" \
  -F "image=@daun.jpg"
```

Untuk ESP32, gunakan `x-api-key: <CAMERA_API_KEY>` dan `device_id` sesuai ID perangkat Tanova. Endpoint analisis dibatasi 20 request per menit.

## 5. Catatan operasional

- Layanan analisis eksternal harus dapat diakses dari server tempat Fastify berjalan.
- Timeout default 90 detik untuk mengakomodasi cold start layanan hosting dan proses analisis gambar.
- Jangan menaruh `IMAGE_API_KEY`, `CAMERA_API_KEY`, atau secret Supabase di frontend.
- `GET /api/v1/ai/diagnoses` adalah riwayat lokal Tanova yang sudah tersimpan dan tersaring sesuai akses pengguna.
