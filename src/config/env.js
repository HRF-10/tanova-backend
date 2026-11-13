import 'dotenv/config';

const bool = (v, d = false) =>
  v === undefined || v === '' ? d : ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
const int = (v, d) => (v === undefined || v === '' ? d : parseInt(v, 10));
const list = (v, d = []) =>
  v === undefined || v === '' ? d : String(v).split(',').map((s) => s.trim()).filter(Boolean);

const nodeEnv = process.env.NODE_ENV || 'development';

export const env = {
  nodeEnv,
  isProd: nodeEnv === 'production',
  port: int(process.env.PORT, 3000),
  host: process.env.HOST || '0.0.0.0',
  corsOrigins: list(process.env.CORS_ORIGIN, ['*']),

  jwt: {
    accessSecret: process.env.JWT_SECRET || 'dev-access-secret-ganti-di-produksi',
    refreshSecret: process.env.JWT_REFRESH_SECRET || 'dev-refresh-secret-ganti-di-produksi',
    accessExpires: process.env.JWT_ACCESS_EXPIRES || '12h',
    refreshExpires: process.env.JWT_REFRESH_EXPIRES || '7d',
  },

  db: {
    // Connection string PostgreSQL dari Supabase (Project Settings > Database > Connection string)
    url: process.env.DATABASE_URL || '',
    // Supabase mewajibkan SSL. Ubah ke false hanya untuk PostgreSQL lokal tanpa SSL.
    ssl: bool(process.env.DB_SSL, true),
    poolMax: int(process.env.DB_POOL_MAX, 5),
    autoMigrate: bool(process.env.AUTO_MIGRATE, true),
  },

  // Kunci enkripsi untuk kredensial ThingsBoard yang disimpan di database (WAJIB diganti di produksi)
  credentialKey: process.env.CREDENTIAL_ENCRYPTION_KEY || 'dev-credential-key-ganti-di-produksi',

  tb: {
    mock: bool(process.env.THINGSBOARD_MOCK, true),
    // Bawaan untuk perangkat yang tidak mengisi URL/akun sendiri dari GUI
    url: process.env.TB_URL || 'https://thingsboard.cloud',
    username: process.env.TB_USERNAME || '',
    password: process.env.TB_PASSWORD || '',
    rpcMode: process.env.TB_RPC_MODE === 'oneway' ? 'oneway' : 'twoway',
    timeoutMs: int(process.env.TB_TIMEOUT_MS, 8000),
    manualMaxDuration: int(process.env.MANUAL_MAX_DURATION, 300), // samakan dengan MANUAL_MAX_DURATION di Raspberry Pi
    // Nama key telemetri di ThingsBoard. Bawaan mengikuti raspi/service_1.py
    keys: {
      ph: process.env.TB_KEY_PH || 'ph',
      ec: process.env.TB_KEY_EC || 'ec',
      tds: process.env.TB_KEY_TDS || 'tds', // tidak dikirim service; diturunkan dari EC
      water_temp: process.env.TB_KEY_WATER_TEMP || 'temp_water',
      air_temp: process.env.TB_KEY_AIR_TEMP || 'temp_air',
      humidity: process.env.TB_KEY_HUMIDITY || 'humidity',
      waterflow: process.env.TB_KEY_WATERFLOW || 'waterflow',
      tank_level: process.env.TB_KEY_TANK_LEVEL || 'tank_level', // belum ada sensornya di service
    },
  },

  tdsFactor: Number(process.env.TDS_FACTOR || 500),
  // Data sensor lebih tua dari ini dianggap basi (nilai dikosongkan agar tidak menyesatkan dan tidak memicu peringatan)
  staleSeconds: int(process.env.TELEMETRY_STALE_SECONDS, 120),

  alerts: {
    enabled: bool(process.env.ALERT_ENGINE_ENABLED, true),
    intervalSec: int(process.env.ALERT_CHECK_INTERVAL_SEC, 30),
  },

  // Tanova AI: foto dari kamera diproses di backend memakai Gemini
  ai: {
    geminiApiKey: process.env.GEMINI_API_KEY || '',
    // Nama model persis seperti id di API Gemini (huruf kecil, pakai tanda hubung)
    model: process.env.GEMINI_MODEL || 'gemini-3.5-flash',
    timeoutMs: int(process.env.GEMINI_TIMEOUT_MS, 30000),
    // Kunci yang dikirim ESP32-S3 CAM lewat header x-api-key. Kosong = kamera tidak bisa mengirim.
    cameraApiKey: process.env.CAMERA_API_KEY || '',
    serviceUrl: (process.env.TANOVAAI_URL || '').replace(/\/+$/, ''),
    serviceApiKey: process.env.TANOVAAI_API_KEY || '',
    serviceTimeoutMs: int(process.env.TANOVAAI_TIMEOUT_MS, 60000),
  },

  // Opsional: simpan foto di Supabase Storage (bucket publik). Kosong = simpan di folder uploads/.
  supabase: {
    url: (process.env.SUPABASE_URL || '').replace(/\/+$/, ''),
    serviceKey: process.env.SUPABASE_SERVICE_KEY || '',
    bucket: process.env.SUPABASE_BUCKET || 'tanova-images',
  },

  uploadDir: process.env.UPLOAD_DIR || './uploads',
  maxUploadMb: int(process.env.MAX_UPLOAD_MB, 5),

  seed: {
    adminEmail: process.env.SEED_ADMIN_EMAIL || 'admin@tanova.local',
    adminUsername: (process.env.SEED_ADMIN_USERNAME || 'admin').toLowerCase(),
    adminPassword: process.env.SEED_ADMIN_PASSWORD || 'Admin12345!',
  },
};

if (env.isProd && (env.jwt.accessSecret.startsWith('dev-') || env.credentialKey.startsWith('dev-'))) {
  throw new Error('JWT_SECRET dan CREDENTIAL_ENCRYPTION_KEY wajib diganti pada NODE_ENV=production');
}
