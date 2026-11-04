import { httpError } from './errors.js';

// Admin boleh melihat semua greenhouse (atau memilih lewat ?greenhouse_id=).
// Operator/viewer hanya bisa mengakses greenhouse miliknya.
export function ghScope(request) {
  const u = request.auth;
  if (u.role === 'admin') return request.query?.greenhouse_id || u.greenhouse_id || null;
  if (!u.greenhouse_id) {
    throw httpError(403, 'Akun belum terhubung ke greenhouse. Lengkapi data greenhouse di profil.', 'NO_GREENHOUSE');
  }
  return u.greenhouse_id;
}

// Untuk aksi tulis: greenhouse harus jelas.
export function ghRequired(request) {
  const scope = ghScope(request) || request.body?.greenhouse_id;
  if (!scope) throw httpError(400, 'greenhouse_id wajib diisi untuk admin tanpa greenhouse', 'GREENHOUSE_REQUIRED');
  return scope;
}
