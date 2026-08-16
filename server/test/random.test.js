import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUnique } from '../src/random.js';

test('无放回抽取不会产生重复候选人', () => {
  let calls = 0;
  const values = [2, 1, 0];
  const selected = randomUnique([1, 2, 3, 4, 5], 3, (max) => {
    const value = values[calls++];
    assert.ok(value >= 0 && value < max);
    return value;
  });
  assert.equal(selected.length, 3);
  assert.equal(new Set(selected).size, 3);
  assert.deepEqual([1, 2, 3, 4, 5], [1, 2, 3, 4, 5], '不修改原数组');
});

test('抽取人数不能超过候选人', () => {
  assert.throws(() => randomUnique([1], 2), /\u8d85\u51fa\u5019\u9009\u4eba/);
});
