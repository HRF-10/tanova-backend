// =====================================================================================
// KONTRAK BACKEND <-> SERVICE (Raspberry Pi / simulator)
//
// Semua hal yang harus dipenuhi service ada di sini dan di docs/KONTRAK-SERVICE.md.
// Saat service diganti atau diubah, yang disesuaikan adalah SERVICE-nya, bukan backend.
// Hanya nama key telemetri yang bisa diubah lewat .env (TB_KEY_*), tanpa mengubah kode.
// =====================================================================================

// Nama RPC yang dikirim backend ke service lewat ThingsBoard
export const RPC = {
  setActuator: 'setActuator', // {"actuator": "<control_key>", "state": true|false, "duration": detik (opsional)}
  setConfig: 'setConfig', //     {"ec": 2.8, ...} sebagian atau semua key pada CONFIG_PROPS
  calibrate: 'calibrate', //     {"sensor": "ph", "key": "ph", "reference_values": {...}} (opsional)
};

// Shared attribute yang ditulis backend. Service membacanya lewat topik v1/devices/me/attributes
export const SHARED_ATTR = { mode: 'mode', wifiSsid: 'wifi_ssid', wifiPassword: 'wifi_password' }; // nilai: "manual" | "auto"

// Susun params RPC setActuator
export function actuatorParams(controlKey, on, duration) {
  const params = { actuator: controlKey, state: Boolean(on) };
  if (duration && on) params.duration = duration;
  return params;
}

// Pengaturan kendali yang boleh diubah dari aplikasi. Batas nilai HARUS sama dengan validasi di service.
export const CONFIG_PROPS = {
  ec_mode: { type: 'string', enum: ['all', 'single'], description: 'all = target EC tetap; single = target EC mengikuti daftar harian (dap)' },
  ec: { type: 'number', minimum: 0, maximum: 20, description: 'Target EC (mS/cm)' },
  ph_down: { type: 'number', minimum: 0, maximum: 14, description: 'Batas bawah pH (di bawah ini pompa pH Up menyala). Harus < ph_up' },
  ph_up: { type: 'number', minimum: 0, maximum: 14, description: 'Batas atas pH (di atas ini pompa pH Down menyala)' },
  fan_air_temp_min: { type: 'number', minimum: -20, maximum: 100, description: 'Pemanas menyala bila suhu udara <= nilai ini. Harus < fan_air_temp_max' },
  fan_air_temp_max: { type: 'number', minimum: -20, maximum: 100, description: 'Kipas menyala bila suhu udara >= nilai ini' },
  fan_humidity: { type: 'number', minimum: 0, maximum: 100, description: 'Kipas menyala bila kelembapan >= nilai ini (%)' },
  peristaltic_pump_duration: { type: 'number', minimum: 1, maximum: 600, description: 'Lama satu kali dosis (detik)' },
  peristaltic_pump_period: { type: 'number', minimum: 0, maximum: 1440, description: 'Jeda antar dosis' },
  waterflow: { type: 'number', minimum: 0, maximum: 1000, description: 'Ambang aliran air; di bawah/sama dengan ini pompa utama ditukar A <-> B' },
  dap: { type: 'array', maxItems: 400, items: { type: 'number', minimum: 0, maximum: 20 }, description: 'Target EC per hari setelah tanam (indeks 0 = hari ke-0)' },
  start_dap: { type: 'string', description: 'Tanggal tanam. ISO 8601 atau "YYYY-MM-DD HH:MM:SS" (waktu WIB)' },
};
export const CONFIG_KEYS = Object.keys(CONFIG_PROPS);

// Pasangan batas yang harus berurutan [kecil, besar, pesan]
export const CONFIG_ORDER_RULES = [
  ['ph_down', 'ph_up', 'ph_down harus lebih kecil dari ph_up'],
  ['fan_air_temp_min', 'fan_air_temp_max', 'fan_air_temp_min harus lebih kecil dari fan_air_temp_max'],
];

// Format tanggal yang diterima service untuk start_dap
export const START_DAP_FORMAT = 'YYYY-MM-DD HH:MM:SS';
