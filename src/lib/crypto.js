import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../config/env.js';

// Kredensial ThingsBoard milik pengguna disimpan terenkripsi (AES-256-GCM), tidak pernah dikirim balik lewat API.
let key;
const getKey = () => (key ??= scryptSync(env.credentialKey, 'tanova-credentials', 32));

export function encrypt(plain) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', getKey(), iv);
  const data = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

export function decrypt(payload) {
  const [version, iv, tag, data] = String(payload).split(':');
  if (version !== 'v1') throw new Error('format kredensial tidak dikenal');
  const decipher = createDecipheriv('aes-256-gcm', getKey(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}
