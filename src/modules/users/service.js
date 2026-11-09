import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';

export async function userWithGreenhouse(userRow) {
  const rows = await db('user_greenhouses')
    .join('greenhouses', 'greenhouses.id', 'user_greenhouses.greenhouse_id')
    .where('user_greenhouses.user_id', userRow.id)
    .select('greenhouses.*');
  // Fallback untuk akun lama sebelum relasi pivot selesai dimigrasikan.
  const greenhouses = rows.length ? rows : (userRow.role !== 'admin' && userRow.greenhouse_id
    ? [await db('greenhouses').where({ id: userRow.greenhouse_id }).first()].filter(Boolean)
    : []);
  return {
    ...dto(userRow, { omit: ['password_hash'] }),
    greenhouse_ids: greenhouses.map((g) => g.id),
    greenhouses: greenhouses.map((g) => dto(g)),
    greenhouse: greenhouses[0] ? dto(greenhouses[0]) : null,
  };
}
