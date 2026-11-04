import { db } from '../db/knex.js';
import { newId } from './ids.js';
import { toJson } from './json.js';
import { now } from './time.js';

export async function logActivity(request, { action, entity, entity_id, description, meta, greenhouse_id }) {
  try {
    await db('activity_logs').insert({
      id: newId(),
      greenhouse_id: greenhouse_id ?? request.auth?.greenhouse_id ?? null,
      user_id: request.auth?.id ?? null,
      action,
      entity: entity ?? null,
      entity_id: entity_id ?? null,
      description: description ?? null,
      meta: toJson(meta),
      ip: request.ip,
      created_at: now(),
    });
  } catch (err) {
    request.log.warn({ err }, 'gagal mencatat log aktivitas');
  }
}
