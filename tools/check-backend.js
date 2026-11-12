
// =====================================================================================
// PEMERIKSA BACKEND + SERVICE (simulator atau Raspberry Pi)
//
// Menjalankan skenario uji ke backend yang sedang berjalan dan menampilkan hasil OK / GAGAL:
// tes koneksi, status terhubung, metrik, ganti mode, kontrol kipas dan dosis, penolakan dosis ganda,
// ubah pengaturan, validasi, dan riwayat.
//
// Pemakaian (backend dan simulator harus sudah berjalan):
//   npm run check -- --device-id=<UUID device ThingsBoard> --tb-user=<email> --tb-pass=<password>
//
// Pilihan lain:
//   --api=http://localhost:3000/api/v1
//   --username=admin
//   --password=Admin12345!
//   --tb-url=https://thingsboard.cloud
//
// Catatan routing:
//   Health Check : GET /health
//   API utama    : /api/v1/...
// =====================================================================================

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter((a) => a.startsWith('--'))
    .map((a) => {
      const i = a.indexOf('=');
      return i === -1
        ? [a.slice(2), 'true']
        : [a.slice(2, i), a.slice(i + 1)];
    })
);

const opt = (name, env, fallback) =>
  args[name] ?? process.env[env] ?? fallback;

// Base URL API utama
const API = opt(
  'api',
  'CHECK_API_URL',
  'http://localhost:3000/api/v1'
).replace(/\/$/, '');

// Health Check berada di luar prefix /api/v1
const HEALTH_URL = opt(
  'health',
  'CHECK_HEALTH_URL',
  API.replace(/\/api\/v1$/, '') + '/health'
).replace(/\/$/, '');

const USERNAME = opt('username', 'CHECK_USERNAME', 'admin');
const PASSWORD = opt('password', 'CHECK_PASSWORD', 'Admin12345!');

const TB_DEVICE_ID = opt('device-id', 'CHECK_TB_DEVICE_ID');
const TB_USER = opt('tb-user', 'CHECK_TB_USER');
const TB_PASS = opt('tb-pass', 'CHECK_TB_PASS');
const TB_URL = opt('tb-url', 'CHECK_TB_URL');

if (!TB_DEVICE_ID || !TB_USER || !TB_PASS) {
  console.error(
    'Isi dulu: --device-id=<UUID device ThingsBoard> ' +
    '--tb-user=<email ThingsBoard> --tb-pass=<password ThingsBoard>'
  );
  process.exit(2);
}

let token = '';
let passed = 0;
let failed = 0;

const sleep = (ms) =>
  new Promise((r) => setTimeout(r, ms));

async function call(method, path, body) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token
        ? { authorization: `Bearer ${token}` }
        : {})
    },
    body: body === undefined
      ? undefined
      : JSON.stringify(body),
    signal: AbortSignal.timeout(40_000),
  });

  const text = await res.text();

  let json = null;

  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }

  return {
    status: res.status,
    body: json
  };
}

async function waitFor(fn, timeoutMs = 25_000, everyMs = 1500) {
  const end = Date.now() + timeoutMs;
  let last;

  while (Date.now() < end) {
    last = await fn().catch(() => undefined);

    if (last) return last;

    await sleep(everyMs);
  }

  return false;
}

async function step(name, fn, { critical = false, hint = '' } = {}) {
  try {
    const detail = await fn();

    if (detail === false) {
      throw new Error('hasil tidak sesuai harapan');
    }

    passed += 1;

    console.log(
      `[OK]    ${name}${
        typeof detail === 'string'
          ? `  (${detail})`
          : ''
      }`
    );

    return true;

  } catch (err) {
    failed += 1;

    console.log(
      `[GAGAL] ${name}\n` +
      `        ${err.message}` +
      `${hint ? `\n        Petunjuk: ${hint}` : ''}`
    );

    if (critical) {
      console.log(
        '\nBerhenti: langkah penting di atas harus berhasil dulu.'
      );

      summary();
    }

    return false;
  }
}

function summary() {
  console.log(
    `\nHasil: ${passed} berhasil, ${failed} gagal.`
  );

  process.exit(failed ? 1 : 0);
}

const expect = (cond, msg) => {
  if (!cond) throw new Error(msg);
};

console.log(`Memeriksa backend di ${API}`);
console.log(`Health Check di ${HEALTH_URL}\n`);

let deviceId;

const actuator = {};

const device = () =>
  call('GET', `/devices/${deviceId}`)
    .then((r) => r.body);

const overview = () =>
  call(
    'GET',
    `/dashboard/overview?device_id=${deviceId}`
  ).then((r) => r.body);

const actuatorState = async (key) =>
  (
    await call(
      'GET',
      `/actuators?device_id=${deviceId}`
    )
  ).body.data.find(
    (a) => a.control_key === key
  )?.state;

const control = (key, state, duration) =>
  call(
    'POST',
    `/actuators/${actuator[key]}/control`,
    {
      state,
      ...(duration ? { duration } : {})
    }
  );

await step(
  'Backend menjawab (/health)',
  async () => {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(10_000)
    });

    expect(
      res.ok,
      `HTTP ${res.status}: endpoint ${HEALTH_URL} tidak dapat diakses`
    );

    const j = await res.json();

    expect(
      j.status === 'ok',
      'status bukan ok'
    );

    expect(
      j.thingsboard === 'live',
      'THINGSBOARD_MOCK masih true. Ubah ke false di .env backend lalu jalankan ulang'
    );

    return `database ${j.database}, thingsboard ${j.thingsboard}`;
  },
  {
    critical: true,
    hint: 'jalankan backend dengan npm run dev dan periksa alamat --api atau --health'
  }
);

await step(
  'Login admin',
  async () => {
    const r = await call(
      'POST',
      '/auth/login',
      {
        username: USERNAME,
        password: PASSWORD
      }
    );

    expect(
      r.status === 200,
      `status ${r.status}: ${r.body?.message}`
    );

    token = r.body.access_token;
  },
  {
    critical: true,
    hint: 'periksa --username dan --password (bawaan seed: admin)'
  }
);

await step(
  'Tes koneksi ThingsBoard (login akun + cek Device ID)',
  async () => {
    const r = await call(
      'POST',
      '/devices/connection/test',
      {
        tb_device_id: TB_DEVICE_ID,
        tb_username: TB_USER,
        tb_password: TB_PASS,
        ...(TB_URL ? { tb_url: TB_URL } : {})
      }
    );

    expect(
      r.body?.ok === true,
      `tahap "${r.body?.stage}": ${
        r.body?.message || JSON.stringify(r.body)
      }`
    );

    return `device "${r.body.device_name}", online=${r.body.online}`;
  },
  {
    critical: true,
    hint: 'tahap login = email/password salah; tahap device = Device ID salah; tahap network = alamat ThingsBoard salah atau beda region (thingsboard.cloud vs eu.thingsboard.cloud)'
  }
);

await step(
  'Menyimpan koneksi pada perangkat uji',
  async () => {
    const list = (
      await call('GET', '/devices')
    ).body.data;

    let dev = list.find(
      (d) => d.tb_device_id === TB_DEVICE_ID
    );

    if (!dev) {
      const created = await call(
        'POST',
        '/devices',
        {
          name: 'Simulator Test',
          zone: 'Uji',
          tb_device_id: TB_DEVICE_ID,
          tb_username: TB_USER,
          tb_password: TB_PASS,
          ...(TB_URL ? { tb_url: TB_URL } : {})
        }
      );

      expect(
        created.status === 201,
        `gagal membuat perangkat: ${created.body?.message}`
      );

      dev = created.body;

    } else {
      const saved = await call(
        'PUT',
        `/devices/${dev.id}/connection`,
        {
          tb_username: TB_USER,
          tb_password: TB_PASS,
          ...(TB_URL ? { tb_url: TB_URL } : {})
        }
      );

      expect(
        saved.status === 200,
        `gagal menyimpan: ${saved.body?.message}`
      );
    }

    deviceId = dev.id;

    const full = await device();

    for (const a of full.actuators) {
      actuator[a.control_key] = a.id;
    }

    expect(
      actuator.fan &&
      actuator.pump_ph_up &&
      actuator.pump_ec_a,
      'aktuator bawaan tidak lengkap'
    );

    return `perangkat ${dev.name}`;
  },
  {
    critical: true
  }
);

await step(
  'Status koneksi menjadi "connected" (maks 40 detik)',
  async () => {
    const ok = await waitFor(
      async () =>
        (await device()).connection.status === 'connected',
      40_000,
      2000
    );

    if (!ok) {
      const c = (await device()).connection;

      throw new Error(
        `status "${c.status}": ${c.message}`
      );
    }
  },
  {
    hint: 'pastikan simulator (atau service) berjalan dan memakai access token device yang sama'
  }
);

await step(
  'Dashboard menampilkan nilai sensor terkini (bukan basi)',
  async () => {
    const o = await overview();

    const ph = o.metrics?.ph;

    expect(
      typeof ph?.value === 'number' && !ph.stale,
      `nilai pH: ${JSON.stringify(ph)}; telemetry_error: ${o.telemetry_error}`
    );

    return `pH ${ph.value}, kelembapan ${o.metrics.humidity.value}, mode ${o.mode}`;
  }
);

await step(
  'Ganti mode ke manual terbaca di dashboard',
  async () => {
    const r = await call(
      'PUT',
      `/devices/${deviceId}/mode`,
      { mode: 'manual' }
    );

    expect(
      r.status === 200,
      `status ${r.status}: ${r.body?.message}`
    );

    return Boolean(
      await waitFor(
        async () =>
          (await overview()).mode === 'manual',
        25_000
      )
    ) || false;
  },
  {
    hint: 'service harus berlangganan atribut shared "mode" (topik v1/devices/me/attributes)'
  }
);

await step(
  'Kontrol kipas ON lalu terbaca dari perangkat',
  async () => {
    const r = await control('fan', 'on');

    expect(
      r.status === 200 &&
      r.body.device_response?.ok !== false,
      `status ${r.status}: ${r.body?.message}`
    );

    return Boolean(
      await waitFor(
        async () => (await actuatorState('fan')) === 'on',
        25_000
      )
    ) || false;
  },
  {
    hint: 'service harus membalas RPC setActuator dan melaporkan status relay di telemetri'
  }
);

await control('fan', 'off');

await step(
  'Dosis pH Up 5 detik menyala lalu mati sendiri',
  async () => {
    const r = await control(
      'pump_ph_up',
      'on',
      5
    );

    expect(
      r.status === 200,
      `status ${r.status}: ${r.body?.message}`
    );

    expect(
      await waitFor(
        async () =>
          (await actuatorState('pump_ph_up')) === 'on',
        15_000
      ),
      'status tidak menjadi on'
    );

    const second = await control(
      'pump_ec_a',
      'on',
      5
    );

    expect(
      second.status === 409 &&
      second.body.code === 'DEVICE_REJECTED',
      `dosis kedua seharusnya ditolak (status ${second.status})`
    );

    expect(
      await waitFor(
        async () =>
          (await actuatorState('pump_ph_up')) === 'off',
        25_000
      ),
      'pompa tidak mati setelah durasi habis'
    );

    return 'dosis kedua ditolak: ' + second.body.message;
  }
);

await step(
  'Ubah pengaturan (target EC) dan terbaca kembali dari perangkat',
  async () => {
    const before = (
      await call(
        'GET',
        `/devices/${deviceId}/config`
      )
    ).body.config.ec;

    const target = Math.round(
      (
        (typeof before === 'number' ? before : 2) + 0.1
      ) * 100
    ) / 100;

    const put = await call(
      'PUT',
      `/devices/${deviceId}/config`,
      { ec: target }
    );

    expect(
      put.status === 200,
      `status ${put.status}: ${put.body?.message}`
    );

    const seen = await waitFor(
      async () =>
        (
          await call(
            'GET',
            `/devices/${deviceId}/config`
          )
        ).body.config.ec === target,
      25_000
    );

    if (typeof before === 'number') {
      await call(
        'PUT',
        `/devices/${deviceId}/config`,
        { ec: before }
      );
    }

    expect(
      seen,
      `ec di perangkat tidak berubah menjadi ${target} (applied=${put.body.applied}, pending=${put.body.pending})`
    );

    return `ec ${before} -> ${target} -> dikembalikan`;
  },
  {
    hint: 'service harus membalas RPC setConfig dan melaporkan atribut klien'
  }
);

await step(
  'Pengaturan tidak valid ditolak (ph_down lebih besar dari ph_up)',
  async () => {
    const r = await call(
      'PUT',
      `/devices/${deviceId}/config`,
      {
        ph_down: 9,
        ph_up: 6
      }
    );

    expect(
      r.status === 400,
      `status ${r.status}`
    );
  }
);

await step(
  'Mode auto: kontrol manual ditolak',
  async () => {
    await call(
      'PUT',
      `/devices/${deviceId}/mode`,
      { mode: 'auto' }
    );

    expect(
      await waitFor(
        async () =>
          (await overview()).mode === 'auto',
        25_000
      ),
      'mode tidak menjadi auto'
    );

    const r = await control('fan', 'on');

    expect(
      r.status === 409,
      `seharusnya 409, dapat ${r.status}`
    );

    return r.body.code;
  }
);

await call(
  'PUT',
  `/devices/${deviceId}/mode`,
  { mode: 'manual' }
);

await step(
  'Riwayat telemetri tersedia',
  async () => {
    const r = await call(
      'GET',
      `/telemetry/history?device_id=${deviceId}&metrics=ph,humidity&limit=50&from=${
        new Date(Date.now() - 3_600_000).toISOString()
      }`
    );

    expect(
      r.status === 200 && r.body.count > 0,
      `jumlah titik: ${r.body?.count}`
    );

    return `${r.body.count} titik`;
  },
  {
    hint: 'jika baru dijalankan, tunggu beberapa menit agar data terkumpul'
  }
);

summary();