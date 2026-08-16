import { randomInt } from 'node:crypto';
import { badRequest } from './errors.js';

export function randomUnique(items, count, rng = randomInt) {
  if (!Array.isArray(items)) throw badRequest('INVALID_CANDIDATES', '候选人必须是数组');
  if (!Number.isInteger(count) || count < 0 || count > items.length) {
    throw badRequest('INVALID_WINNER_COUNT', '中奖人数超出候选人范围');
  }
  const pool = [...items];
  for (let i = 0; i < count; i += 1) {
    const offset = rng(pool.length - i);
    const selected = i + offset;
    [pool[i], pool[selected]] = [pool[selected], pool[i]];
  }
  return pool.slice(0, count);
}
