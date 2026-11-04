import { httpError } from '../lib/errors.js';
import { tbFor } from './thingsboard.js';

// Kirim RPC ke Raspberry Pi lewat akun ThingsBoard milik perangkat. service_1.py SELALU membalas
// {"ok": true/false, "error": "..."}; penolakan dari perangkat diubah menjadi error 409
// agar frontend bisa menampilkan alasannya.
export async function sendCommand(device, method, params) {
  const result = await tbFor(device).sendRpc(device.tb_device_id, method, params);
  if (result && typeof result === 'object' && result.ok === false) {
    const reason = result.error || (result.rejected ? JSON.stringify(result.rejected) : 'ditolak perangkat');
    const err = httpError(409, `Perangkat menolak perintah: ${reason}`, 'DEVICE_REJECTED');
    err.device = result;
    throw err;
  }
  return result ?? null;
}
