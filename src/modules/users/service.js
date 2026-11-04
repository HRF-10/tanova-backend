import { db } from '../../db/knex.js';
import { dto } from '../../lib/dto.js';

export async function userWithGreenhouse(userRow) {
  const greenhouse = userRow.greenhouse_id
    ? await db('greenhouses').where({ id: userRow.greenhouse_id }).first()
    : null;
  return {
    ...dto(userRow, { omit: ['password_hash'] }),
    greenhouse: greenhouse ? dto(greenhouse) : null,
  };
}
