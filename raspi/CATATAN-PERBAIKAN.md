# Catatan perbaikan service_1.py

File ini membandingkan `service_1.py` yang Anda kirim dengan versi di folder ini.

## Yang diperbaiki

1. **`CLIENT_ID` wajib diisi.** Sebelumnya bila kosong, topik menjadi `None/device-001` dan kunci Redis salah tanpa pesan galat. Sekarang program berhenti dengan pesan yang jelas.
2. **`is_active` tidak lagi memblokir data.** Bila kunci `is_active` tidak ada di konfigurasi lama, terjadi `KeyError` yang ditelan oleh `except`, sehingga data sensor tidak pernah tersimpan. Sekarang dianggap aktif.
3. **Dosis EC berhenti bila mode diganti ke manual di tengah jalan.** Sebelumnya setelah pompa A selesai, pompa B tetap menyala sendiri walau mode sudah manual dan semua dosis sudah dimatikan.
4. **Variabel internal disamakan dengan relay saat sensor terputus (mode otomatis).** Relay dikembalikan ke keadaan aman (hanya pompa A menyala), tetapi variabel `fan`, `heater`, `pump_2`, dan pompa dosis tetap bernilai lama. Akibatnya setelah sensor pulih, kendali otomatis mengira kipas sudah menyala dan tidak menyalakannya. Sekarang variabel ikut direset.
5. **Hal kecil:** format pesan gagal terhubung ke broker lokal diperbaiki, dan `print` sisa debug dihapus.

## Hal yang tidak saya ubah, perlu keputusan Anda

Perilaku di bawah ini memengaruhi dosis dan pemanas di alat sungguhan, jadi saya biarkan dan hanya saya laporkan.

- **Jeda dosis pH memakai satuan detik, EC memakai menit.** `peristaltic_pump_period` dikali 60 untuk EC tetapi tidak untuk pH. Dengan nilai bawaan 1, setelah dosis pH sistem hanya menunggu 1 detik sebelum memeriksa lagi, padahal larutan butuh waktu bercampur. Ini bisa menyebabkan pH terdosis berlebihan. Pertimbangkan menyamakan satuannya.
- **Nilai bawaan `fan_air_temp_min` adalah 30.** Pemanas menyala bila suhu udara kurang dari atau sama dengan 30, sehingga di iklim tropis pemanas bisa menyala hampir terus. Ubah dari website (misalnya 18 sampai 20).
- **Nilai bawaan `fan_humidity` adalah 30.** Kipas menyala bila kelembapan di atas 30 persen, jadi hampir selalu menyala. Sesuaikan dari website.
- **Password broker lokal bawaan masih tertulis di kode.** Isi `LOCAL_MQTT_PASSWORD` di `.env`.
- **Kalibrasi belum diimplementasi di service.** RPC `calibrate` tidak dikenal. Pencatatan kalibrasi di backend tetap berfungsi sebagai catatan manual.
- **Tidak ada sensor level tangki.** Backend menyediakan metrik `tank_level` tetapi nilainya kosong sampai sensor ditambahkan dan dikirim sebagai telemetri `tank_level`.
- **`publish()` menunggu 2 detik setiap pesan.** Perintah dari website diproses satu per satu, jadi balasan RPC bisa lambat saat banyak perintah antre.
- **Variabel `MQTT_BROKER`, `MQTT_PORT`, `MQTT_USERNAME`, `MQTT_PASSWORD` sekarang dibaca (revisi 3).** Di kode asli variabel ini diabaikan dan broker selalu `localhost`. Sekarang bila diisi, service memakainya, termasuk TLS otomatis di port 8883. Bila tidak diisi, perilakunya sama dengan kode asli. Firmware Wemos menentukan broker mana yang benar, jadi uji dulu seperti di README.
- **Access token ThingsBoard di `.env` hanya untuk Raspberry Pi.** Jangan dibagikan atau dimasukkan ke Git. Jika sudah terlanjur terlihat orang lain, buat ulang lewat ThingsBoard (Device > Manage credentials) lalu perbarui `.env`.
