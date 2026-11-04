import { parseJson } from './json.js';

// Ubah baris database menjadi JSON API: *_at (epoch ms) -> ISO, is_* -> boolean, kolom JSON -> objek.
export function dto(row, { json = [], omit = [] } = {}) {
  if (!row) return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    if (omit.includes(k)) continue;
    if (k.endsWith('_at') && v !== null && v !== undefined) out[k] = new Date(Number(v)).toISOString();
    else if (k.startsWith('is_')) out[k] = Boolean(v);
    else if (json.includes(k)) out[k] = parseJson(v, null);
    else out[k] = v;
  }
  return out;
}
