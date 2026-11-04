import { db } from '../db/knex.js';
import { env } from '../config/env.js';
import { dto } from './dto.js';
import { httpError } from './errors.js';

export async function findDevice(id, scope) {
  const q = db('devices').where({ id });
  if (scope) q.andWhere({ greenhouse_id: scope });
  const device = await q.first();
  if (!device) throw httpError(404, 'Perangkat tidak ditemukan', 'DEVICE_NOT_FOUND');
  return device;
}

// Jika device_id tidak diberikan, pakai perangkat pertama pada scope.
export async function pickDevice(id, scope) {
  if (id) return findDevice(id, scope);
  const q = db('devices').orderBy('created_at', 'asc');
  if (scope) q.where({ greenhouse_id: scope });
  return (await q.first()) || null;
}

// Bentuk perangkat untuk API: password ThingsBoard tidak pernah ikut keluar.
export function deviceDto(row) {
  const out = dto(row, { json: ['config'], omit: ['tb_password_enc'] });
  out.tb_connection = {
    url: row.tb_url || env.tb.url,
    username: row.tb_username || null,
    device_id: row.tb_device_id || null,
    has_password: Boolean(row.tb_password_enc),
    configured: Boolean(row.tb_device_id && ((row.tb_username && row.tb_password_enc) || (!row.tb_username && env.tb.username && env.tb.password))),
  };
  return out;
}
