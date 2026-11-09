import fs from 'node:fs/promises';
import path from 'node:path';
import { env } from '../config/env.js';
import { httpError } from '../lib/errors.js';
import { newId } from '../lib/ids.js';

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };

// Tentukan tipe gambar dari isi file, bukan dari header (ESP32 sering salah mengirim Content-Type).
export function sniffMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return 'image/png';
  if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

// Simpan ke Supabase Storage jika SUPABASE_URL dan SUPABASE_SERVICE_KEY diisi, selain itu ke folder uploads/.
export async function saveImage(buffer, mime) {
  const name = `${newId()}${EXT[mime]}`;
  const { url, serviceKey, bucket } = env.supabase;

  if (url && serviceKey) {
    const objectPath = `${new Date().toISOString().slice(0, 10)}/${name}`;
    const res = await fetch(`${url}/storage/v1/object/${bucket}/${objectPath}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${serviceKey}`, apikey: serviceKey, 'Content-Type': mime },
      body: buffer,
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw httpError(502, `Gagal mengunggah foto ke Supabase Storage (HTTP ${res.status})`, 'STORAGE_ERROR');
    return `${url}/storage/v1/object/public/${bucket}/${objectPath}`;
  }

  await fs.writeFile(path.resolve(env.uploadDir, name), buffer);
  return `/uploads/${name}`;
}
