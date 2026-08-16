import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, transaction } from '../src/db.js';
import { SyncService } from '../src/sync.js';
import { LotteryService } from '../src/lotteries.js';
import { GroupEntitlementService } from '../src/group-entitlements.js';
import { ActivityService } from '../src/activities.js';

const projectEnv = resolve(fileURLToPath(new URL('../../.env', import.meta.url)));
try {
  loadEnvFile(projectEnv);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
const db = openDatabase(process.env.DATABASE_URL);
const suffix = Date.now() % 100_000;
const userId = 1_900_000_000 + suffix;
const actorUserId = 1_800_000_000 + suffix;
const groupId = 1_700_000_000 + suffix;
const marker = `postgres-feature-verify-${Date.now()}`;
const now = new Date().toISOString();
let groupRuleId = null;
const upstreamUser = {
  id: userId,
  email: `${marker}@example.invalid`,
  username: marker,
  role: 'user',
  status: 'active',
  balance: 100,
  total_recharged: 20,
  allowed_groups: [],
  created_at: '2026-01-01T00:00:00.000Z'
};

const client = {
  async listGroups() {
    return [{
      id: groupId,
      name: marker,
      status: 'active',
      is_exclusive: true,
      rate_multiplier: 0.01
    }];
  },
  async getUser() {
    return structuredClone(upstreamUser);
  },
  async getUserBalanceHistory(_userId, options = {}) {
    if (!options.pageSize) return { items: [], pages: 1, total_recharged: 20 };
    if (options.type !== 'balance') return { items: [], pages: 1, total_recharged: 20 };
    return {
      items: [{
        id: marker,
        code: marker,
        type: 'balance',
        value: 20,
        status: 'used',
        used_by: userId,
        used_at: now,
        notes: ''
      }],
      pages: 1,
      total_recharged: 20
    };
  },
  async updateUserAllowedGroups(_userId, allowedGroups) {
    upstreamUser.allowed_groups = [...allowedGroups];
    return structuredClone(upstreamUser);
  }
};

const config = {
  rewardCodePrefix: 'S2EXT-',
  activityTimeZone: 'Asia/Shanghai',
  autoDrawIntervalMs: 10_000
};
const sync = new SyncService(db, client, config);
const lotteries = new LotteryService(db, sync, config);
const groups = new GroupEntitlementService(db, client, sync);
const activities = new ActivityService(db, client, sync, lotteries, groups, config);
const recentCondition = {
  type: 'fact',
  fact: 'recent_recharge_total',
  operator: 'gte',
  value: 10,
  window_days: 7
};

try {
  const groupRule = await groups.createRule({
    name: marker,
    group_id: groupId,
    enabled: true,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: marker,
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z',
    condition: recentCondition
  }, actorUserId);
  groupRuleId = groupRule.id;
  const claim = await groups.claim(groupRule.id, userId);
  assert.equal(claim.granted, true);
  assert.equal(claim.facts.recent_recharge_totals['7'], 20);

  await groups.updateRule(groupRule.id, {
    name: marker,
    group_id: groupId,
    enabled: true,
    assignment_mode: 'claim',
    activity_description: marker,
    activity_ends_at: '2019-01-01T00:00:00.000Z',
    revoke_at: '2020-01-01T00:00:00.000Z',
    condition: recentCondition
  }, actorUserId);
  await assert.rejects(
    () => activities.getForUser('group_entitlement', groupRule.id, userId),
    (error) => error.code === 'NOT_FOUND'
  );
  const expired = await groups.execute(groupRule.id, null, {
    forceRevoke: true,
    mode: 'expire',
    skipSync: true
  });
  assert.equal(expired.status, 'succeeded');
  assert.equal(expired.revoked_count, 1);
  assert.deepEqual(upstreamUser.allowed_groups, []);

  const checkin = activities.createCheckin({
    name: marker,
    description: marker,
    published: true,
    reward_type: 'none',
    reward_value: 0,
    condition: recentCondition
  }, actorUserId);
  const checked = await activities.participate('checkin', checkin.id, userId);
  assert.equal(checked.participation.checked_today, true);

  const lottery = lotteries.create({
    name: marker,
    description: marker,
    published: true,
    condition: recentCondition,
    prizes: [{
      name: marker,
      winner_count: 1,
      reward_type: 'manual',
      reward_value: 0,
      sort_order: 0
    }]
  }, actorUserId);
  lotteries.start(lottery.id, actorUserId);
  const entry = await lotteries.participate(lottery.id, userId);
  assert.equal(entry.participated, true);
  assert.equal(entry.facts.recent_recharge_totals['7'], 20);

  console.log('PostgreSQL 近期充值、签到、抽奖参与、分组申请和到期撤销验证通过');
} finally {
  transaction(db, () => {
    db.prepare('DELETE FROM checkin_records WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM checkin_campaigns WHERE created_by = ? AND name = ?').run(actorUserId, marker);
    db.prepare('DELETE FROM lotteries WHERE created_by = ? AND name = ?').run(actorUserId, marker);
    db.prepare('DELETE FROM group_entitlement_memberships WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM group_entitlement_rules WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM synced_groups WHERE group_id = ?').run(groupId);
    db.prepare('DELETE FROM recharge_events WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM synced_users WHERE user_id = ?').run(userId);
    db.prepare('DELETE FROM audit_events WHERE actor_user_id IN (?, ?)').run(actorUserId, userId);
    db.prepare(`
      DELETE FROM audit_events
      WHERE actor_user_id IS NULL
        AND ((entity_type = 'user' AND entity_id = ?)
          OR (entity_type = 'group_entitlement_rule' AND entity_id = ?))
    `).run(String(userId), String(groupRuleId || ''));
  });
  db.close();
}
