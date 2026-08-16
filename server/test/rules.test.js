import test from 'node:test';
import assert from 'node:assert/strict';
import {
  conditionFromApi,
  conditionToApi,
  evaluateRule,
  makeUserFacts,
  rechargeWindowDays,
  validateRuleTree
} from '../src/rules.js';

test('前端条件会规范化为分和 all/any', () => {
  const rule = conditionFromApi({
    type: 'group',
    operator: 'and',
    children: [
      { type: 'fact', fact: 'current_balance', operator: 'gte', value: 12.34 },
      { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 }
    ]
  });
  assert.deepEqual(rule, {
    op: 'all',
    children: [
      { fact: 'balance_cents', operator: 'gte', value: '1234' },
      { fact: 'recharge_total_cents', operator: 'gt', value: '0' }
    ]
  });
  assert.deepEqual(conditionToApi(rule), {
    type: 'group',
    operator: 'and',
    children: [
      { type: 'fact', fact: 'current_balance', operator: 'gte', value: 12.34 },
      { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 }
    ]
  });
});

test('近期充值条件支持自定义天数并返回明确原因', () => {
  const condition = {
    type: 'fact',
    fact: 'recent_recharge_total',
    operator: 'gte',
    value: 10,
    window_days: 7
  };
  const rule = conditionFromApi(condition);
  assert.deepEqual(rule, {
    fact: 'recent_recharge_total_cents',
    operator: 'gte',
    value: '1000',
    window_days: 7
  });
  assert.deepEqual(conditionToApi(rule), condition);
  assert.deepEqual(rechargeWindowDays({
    op: 'all',
    children: [rule, { ...rule, window_days: 30 }]
  }), [7, 30]);

  const failed = evaluateRule(rule, {
    recent_recharge_totals_cents: { '7': '999' }
  });
  assert.equal(failed.matched, false);
  assert.deepEqual(failed.reasons, ['最近 7 天累计充值金额不足，需要至少 10 元']);
  assert.equal(evaluateRule(rule, {
    recent_recharge_totals_cents: { '7': '1000' }
  }).matched, true);
});

test('近期充值条件拒绝无效时间范围', () => {
  for (const windowDays of [0, 366, 7.5, '7']) {
    assert.throws(() => conditionFromApi({
      type: 'fact', fact: 'recent_recharge_total', operator: 'gte', value: 10,
      window_days: windowDays
    }), /充值时间范围/);
  }
});

test('旧充值状态条件会转换为累计充值金额条件', () => {
  assert.deepEqual(conditionToApi({
    fact: 'has_recharged', operator: 'eq', value: true
  }), {
    type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0
  });
  assert.deepEqual(conditionToApi({
    fact: 'has_recharged', operator: 'eq', value: false
  }), {
    type: 'fact', fact: 'recharge_total', operator: 'lte', value: 0
  });
});

test('组合条件支持嵌套且返回可解释原因', () => {
  const rule = validateRuleTree({
    op: 'all',
    children: [
      { fact: 'balance_cents', operator: 'gt', value: '1000' },
      {
        op: 'any',
        children: [
          { fact: 'recharge_total_cents', operator: 'gt', value: '0' },
          { fact: 'recharge_count', operator: 'gte', value: 2 }
        ]
      }
    ]
  });
  const failed = evaluateRule(rule, {
    balance_cents: '900', recharge_total_cents: '0', recharge_count: 0
  });
  assert.equal(failed.matched, false);
  assert.ok(failed.reasons.includes('当前余额需要大于 10 元'));
  assert.ok(failed.reasons.includes('累计充值金额需要大于 0 元'));
  assert.ok(failed.reasons.includes('充值次数不足，需要至少 2 次'));
  assert.ok(failed.reasons.includes('以上可选条件均未满足'));
  assert.equal(evaluateRule(rule, {
    balance_cents: '1001', recharge_total_cents: '1', recharge_count: 1
  }).matched, true);
});

test('空根条件组按所有用户处理', () => {
  const rule = conditionFromApi({ type: 'group', operator: 'or', children: [] });
  assert.deepEqual(rule, { op: 'all', children: [] });
  assert.equal(evaluateRule(rule, {}).matched, true);
});

test('条件校验拒绝未知事实和不安全字段', () => {
  assert.throws(() => conditionFromApi({
    type: 'fact', fact: 'sql', operator: 'eq', value: true
  }), /\u4e0d\u652f\u6301\u7684\u6761\u4ef6/);
  assert.throws(() => validateRuleTree({
    fact: 'has_recharged', operator: 'eq', value: true, query: 'DROP TABLE users'
  }), /\u672a\u77e5\u5b57\u6bb5/);
  assert.throws(() => conditionFromApi({
    type: 'fact', fact: 'has_recharged', operator: 'eq', value: true, sql: 'SELECT 1'
  }), /\u672a\u77e5\u5b57\u6bb5/);
});

test('用户事实使用定点字符串与 UTC 注册天数', () => {
  const facts = makeUserFacts(
    { balance_cents: '1234', status: 'active', created_at: '2026-07-01T00:00:00.000Z' },
    { recharge_count: 2, recharge_total_cents: '5000' },
    new Date('2026-07-31T12:00:00.000Z')
  );
  assert.deepEqual(facts, {
    balance_cents: '1234',
    has_recharged: true,
    recharge_total_cents: '5000',
    recent_recharge_totals_cents: {},
    recharge_count: 2,
    account_age_days: 30,
    user_status: 'active'
  });
});
