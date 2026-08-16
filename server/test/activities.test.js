import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { SyncService } from '../src/sync.js';
import { LotteryService } from '../src/lotteries.js';
import { GroupEntitlementService } from '../src/group-entitlements.js';
import { ActivityService } from '../src/activities.js';
import { makeUserFacts } from '../src/rules.js';

test('Sub2API 累计充值金额会生成正确资格事实', () => {
  const facts = makeUserFacts({
    balance_cents: '1000',
    total_recharged_cents: '2500',
    created_at: '2026-01-01T00:00:00Z',
    status: 'active'
  }, { recharge_count: 0, recharge_total_cents: '0' });
  assert.equal(facts.has_recharged, true);
  assert.equal(facts.recharge_total_cents, '2500');
  assert.equal(facts.recharge_count, 1);
  const rewardOnly = makeUserFacts({
    balance_cents: '200',
    total_recharged_cents: '200',
    created_at: '2026-01-01T00:00:00Z',
    status: 'active'
  }, { recharge_count: 0, recharge_total_cents: '0', excluded_reward_cents: '200' });
  assert.equal(rewardOnly.has_recharged, false, '扩展奖励不能反向制造充值资格');
});

test('主动领取规则不会批量授予，用户点击后才安全加入专属分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await fixture.sync.run();
  const rule = await fixture.groups.createRule({
    name: '领取狂欢资格',
    group_id: 5,
    enabled: true,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: '充值用户可领取',
    activity_starts_at: null,
    activity_ends_at: null,
    condition: { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 }
  }, 99);

  assert.deepEqual(await fixture.groups.executeScheduled({ skipSync: true }), []);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9]);
  const result = await fixture.groups.claim(rule.id, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.granted, true);
  assert.equal(result.already_granted, false);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 9]);

  const repeated = await fixture.groups.claim(rule.id, 1);
  assert.equal(repeated.already_granted, true);
  assert.equal(fixture.updates.length, 1, '重复领取不能重复写回 Sub2API');
});

test('活动中心聚合三类活动，签到同一天只记录并奖励一次', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await fixture.sync.run();
  const rule = await fixture.groups.createRule({
    name: '狂欢资格', group_id: 5, enabled: true, revoke_when_ineligible: false,
    assignment_mode: 'claim', activity_description: '领取专属倍率',
    condition: { type: 'group', operator: 'and', children: [] }
  }, 99);
  fixture.activities.createCheckin({
    name: '每日签到', description: '每天签到领取余额', published: true,
    reward_type: 'balance', reward_value: 2,
    starts_at: null, ends_at: null,
    condition: { type: 'fact', fact: 'has_recharged', operator: 'eq', value: true }
  }, 99);
  const lottery = fixture.lotteries.create({
    name: '管理员抽奖', description: '统一开奖', published: true,
    starts_at: null, ends_at: null,
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '10 元余额', winner_count: 1, reward_type: 'balance', reward_value: 10, sort_order: 0 }]
  }, 99);
  fixture.lotteries.start(lottery.id, 99);

  const list = await fixture.activities.listForUser(1);
  assert.deepEqual(new Set(list.items.map((item) => item.type)), new Set(['lottery', 'checkin', 'group_entitlement']));
  const lotteryActivity = list.items.find((item) => item.type === 'lottery');
  const lotteryEntry = await fixture.activities.participate('lottery', lotteryActivity.id, 1);
  assert.equal(lotteryEntry.participated, true);
  assert.equal(lotteryEntry.eligible, true);
  const checkin = list.items.find((item) => item.type === 'checkin');
  const [first, second] = await Promise.all([
    fixture.activities.checkin(checkin.id, 1),
    fixture.activities.checkin(checkin.id, 1)
  ]);
  assert.equal(first.participation.checked_today, true);
  assert.deepEqual(first.participation.checked_dates, [first.participation.today]);
  assert.equal(first.participation.current_month, first.participation.today.slice(0, 7));
  assert.equal(second.participation.total_days, 1);
  assert.equal(fixture.rewards.length, 1);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM checkin_records').get().count, 1);
  assert.equal(rule.assignment_mode, 'claim');
});

test('资格活动结束后对用户隐藏但尚未到撤销时间', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await fixture.sync.run();
  const rule = await fixture.groups.createRule({
    name: '已结束狂欢资格',
    group_id: 5,
    enabled: true,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: '',
    activity_ends_at: '2020-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z',
    condition: { type: 'group', operator: 'and', children: [] }
  }, 99);

  const list = await fixture.activities.listForUser(1);
  assert.equal(list.items.some((item) => item.type === 'group_entitlement' && item.id === rule.id), false);
  await assert.rejects(
    () => fixture.activities.getForUser('group_entitlement', rule.id, 1),
    (error) => error.code === 'NOT_FOUND'
  );
  assert.deepEqual(await fixture.groups.executeScheduled(), [], '撤销时间未到时不能提前自动撤销');
});

test('签到和狂欢资格未满足条件时返回具体原因且不产生记录', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await fixture.sync.run();
  const rule = await fixture.groups.createRule({
    name: '充值狂欢资格', group_id: 5, enabled: true, revoke_when_ineligible: false,
    assignment_mode: 'claim', activity_description: '充值且余额达标后领取',
    condition: {
      type: 'group', operator: 'and', children: [
        { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 },
        { type: 'fact', fact: 'current_balance', operator: 'gte', value: 20 }
      ]
    }
  }, 99);
  const checkin = fixture.activities.createCheckin({
    name: '充值签到', description: '', published: true, reward_type: 'none', reward_value: 0,
    condition: {
      type: 'group', operator: 'and', children: [
        { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 },
        { type: 'fact', fact: 'current_balance', operator: 'gte', value: 20 }
      ]
    }
  }, 99);

  const checkinResult = await fixture.activities.participate('checkin', checkin.id, 2);
  assert.deepEqual(checkinResult.reasons, ['累计充值金额需要大于 0 元', '当前余额不足，需要至少 20 元']);
  assert.equal(fixture.db.prepare('SELECT COUNT(*) AS count FROM checkin_records WHERE user_id = 2').get().count, 0);

  const claimResult = await fixture.activities.participate('group_entitlement', rule.id, 2);
  assert.deepEqual(claimResult.reasons, ['累计充值金额需要大于 0 元', '当前余额不足，需要至少 20 元']);
  assert.equal(claimResult.granted, false);
  assert.deepEqual(fixture.users.get(2).allowed_groups, []);
});

function createFixture() {
  const db = openDatabase(':memory:');
  const users = new Map([
    [1, {
      id: 1,
      email: 'user@example.com',
      username: 'user',
      role: 'user',
      status: 'active',
      balance: 100,
      total_recharged: 0,
      allowed_groups: [9],
      created_at: '2026-01-01T00:00:00Z'
    }],
    [2, {
      id: 2,
      email: 'new@example.com',
      username: 'new-user',
      role: 'user',
      status: 'active',
      balance: 5,
      total_recharged: 0,
      allowed_groups: [],
      created_at: '2026-07-01T00:00:00Z'
    }]
  ]);
  const updates = [];
  const rewards = [];
  const rechargeTotals = new Map([[1, 50], [2, 0]]);
  const client = {
    async listGroups() {
      return [{ id: 5, name: '狂欢分组', status: 'active', is_exclusive: true, rate_multiplier: 0.01 }];
    },
    async listUsers() { return { items: [...users.values()].map(clone), pages: 1 }; },
    async listRedeemCodes() { return { items: [], pages: 1 }; },
    async getUser(userId) { return clone(users.get(Number(userId))); },
    async getUserBalanceHistory(userId) {
      return { items: [], total: 0, total_recharged: rechargeTotals.get(Number(userId)) || 0 };
    },
    async updateUserAllowedGroups(userId, allowedGroups) {
      users.get(Number(userId)).allowed_groups = [...allowedGroups];
      updates.push({ user_id: Number(userId), allowed_groups: [...allowedGroups] });
      return clone(users.get(Number(userId)));
    },
    async createAndRedeem(payload, idempotencyKey) {
      rewards.push({ payload, idempotencyKey });
      return { redeem_code: { id: rewards.length } };
    }
  };
  const config = {
    rewardCodePrefix: 'S2EXT-',
    activityTimeZone: 'Asia/Shanghai'
  };
  const sync = new SyncService(db, client, config);
  const lotteries = new LotteryService(db, sync, config);
  const groups = new GroupEntitlementService(db, client, sync);
  const activities = new ActivityService(db, client, sync, lotteries, groups, config);
  return { db, users, updates, rewards, client, sync, lotteries, groups, activities };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
