import { httpError } from './errors.js';

// Admin global secara default; user dibatasi ke greenhouse yang benar-benar ditetapkan.
// User dapat memilih salah satu greenhouse melalui ?greenhouse_id=...
export function ghScope(request) {
  const u = request.auth;
  if (u.role === 'admin') return request.query?.greenhouse_id || null;
  const ids = u.greenhouse_ids || (u.greenhouse_id ? [u.greenhouse_id] : []);
  if (!ids.length) throw httpError(403, 'Akun belum memiliki greenhouse. Hubungi admin.', 'NO_GREENHOUSE');
  const requested = request.query?.greenhouse_id;
  if (requested) {
    if (!ids.includes(requested)) throw httpError(403, 'Greenhouse bukan milik akun ini', 'GREENHOUSE_FORBIDDEN');
    return requested;
  }
  return ids[0];
}

export function ghRequired(request) {
  const scope = ghScope(request) || request.body?.greenhouse_id;
  if (!scope) throw httpError(400, 'greenhouse_id wajib dipilih oleh admin', 'GREENHOUSE_REQUIRED');
  if (request.auth.role !== 'admin') {
    const ids = request.auth.greenhouse_ids || [];
    if (!ids.includes(scope)) throw httpError(403, 'Greenhouse bukan milik akun ini', 'GREENHOUSE_FORBIDDEN');
  }
  return scope;
}
