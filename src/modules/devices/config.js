import { httpError } from '../../lib/errors.js';
import { findDevice } from '../../lib/devices.js';
import { ghScope } from '../../lib/scope.js';
import { logActivity } from '../../lib/activity.js';
import { toMs } from '../../lib/time.js';
import { CONFIG_KEYS, CONFIG_ORDER_RULES, CONFIG_PROPS, RPC } from '../../config/contract.js';
import { sendCommand } from '../../services/deviceCommand.js';
import { tbFor } from '../../services/thingsboard.js';

const tags = ['Device Config'];
const security = [{ bearerAuth: [] }];
const idParam = { type: 'object', properties: { id: { type: 'string' } } };

const configProps = CONFIG_PROPS;

const WIB = new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
});

// Perangkat hanya menerima "YYYY-MM-DD HH:MM:SS" (waktu lokal Raspberry Pi, diasumsikan WIB)
function normalizeStartDap(value) {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) return value;
  const ms = toMs(value);
  if (ms === null) throw httpError(400, 'start_dap tidak valid. Gunakan ISO 8601 atau YYYY-MM-DD HH:MM:SS', 'VALIDATION_ERROR');
  return WIB.format(new Date(ms)).replace(',', '');
}

function checkOrder(merged, low, high, message) {
  if (typeof merged[low] === 'number' && typeof merged[high] === 'number' && !(merged[low] < merged[high])) {
    throw httpError(400, message, 'VALIDATION_ERROR');
  }
}

export default async function deviceConfigRoutes(app) {
  const ro = [app.authenticate];
  const rw = [app.authenticate, app.requireRole('admin', 'operator')];

  async function currentConfig(device) {
    if (!device.tb_device_id) return null;
    return tbFor(device).getAttributes(device.tb_device_id, [...CONFIG_KEYS, 'mode', 'config_errors', 'is_active'], 'CLIENT_SCOPE');
  }

  // Pengaturan yang BERLAKU di perangkat (dilaporkan service_1.py sebagai client attributes)
  app.get('/devices/:id/config', { onRequest: ro, schema: { tags, security, summary: 'Pengaturan kendali yang berlaku di perangkat', params: idParam } }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');
    const attrs = await currentConfig(device);
    const { config_errors = {}, mode = null, is_active = null, ...config } = attrs;
    return {
      device_id: device.id,
      mode,
      config,
      // alasan penolakan untuk pengaturan terakhir yang tidak valid menurut perangkat (kosong = semua diterima)
      config_errors: typeof config_errors === 'object' && config_errors ? config_errors : {},
      reported: Object.keys(config).length > 0,
    };
  });

  app.put('/devices/:id/config', {
    onRequest: rw,
    schema: {
      tags, security, params: idParam,
      summary: 'Ubah pengaturan kendali (target EC, batas pH, kipas/pemanas, dosis, DAP)',
      description:
        'Kirim sebagian atau semua field. Perintah dikirim ke perangkat lewat RPC setConfig (hasil langsung) lalu disimpan sebagai shared attribute ' +
        'agar tetap berlaku saat Raspberry Pi restart. Jika perangkat offline, pengaturan tetap disimpan dan diterapkan saat perangkat terhubung (pending: true).',
      body: { type: 'object', additionalProperties: false, minProperties: 1, properties: configProps },
    },
  }, async (request) => {
    const device = await findDevice(request.params.id, ghScope(request));
    if (!device.tb_device_id) throw httpError(422, 'Perangkat belum memiliki tb_device_id (ThingsBoard)', 'NO_TB_DEVICE');

    const payload = { ...request.body };
    if (payload.start_dap !== undefined) payload.start_dap = normalizeStartDap(payload.start_dap);

    // Pemeriksaan urutan batas terhadap pengaturan yang sedang berlaku (perangkat juga memeriksa hal yang sama)
    const current = (await currentConfig(device).catch(() => null)) || {};
    const merged = { ...current, ...payload };
    for (const [low, high, message] of CONFIG_ORDER_RULES) checkOrder(merged, low, high, message);

    let device_result = null;
    let pending = false;
    try {
      device_result = await sendCommand(device, RPC.setConfig, payload);
    } catch (err) {
      if (err.code === 'DEVICE_REJECTED') throw err; // ditolak perangkat: jangan disimpan
      if (!String(err.code || '').startsWith('TB_')) throw err;
      pending = true; // perangkat offline/tidak merespons: simpan saja, terapkan saat tersambung
    }
    await tbFor(device).setSharedAttributes(device.tb_device_id, payload);

    await logActivity(request, {
      action: 'device.update_config', entity: 'device', entity_id: device.id,
      description: `Mengubah pengaturan kendali ${device.name}${pending ? ' (menunggu perangkat online)' : ''}`,
      meta: payload, greenhouse_id: device.greenhouse_id,
    });
    return { saved: true, applied: !pending, pending, config: payload, device: device_result };
  });
}
