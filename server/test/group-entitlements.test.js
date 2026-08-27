import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { SyncService } from '../src/sync.js';
import { GroupEntitlementService } from '../src/group-entitlements.js';

test('规则固定为用户手动申请且拒绝自动授权模式', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());

  await assert.rejects(
    () => fixture.service.createRule({
      ...ruleInput(5),
      assignment_mode: 'automatic'
    }, 99),
    (error) => error.code === 'GROUP_RULE_MANUAL_ONLY'
  );

  const rule = await fixture.service.createRule(ruleInput(5), 99);
  assert.equal(rule.assignment_mode, 'claim');
  assert.equal(rule.revoke_when_ineligible, false);
  assert.deepEqual(await fixture.service.executeScheduled(), []);
  assert.equal(fixture.calls.listUsers, 0);
  assert.equal(fixture.calls.listRedeemCodes, 0);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9], '用户没有申请时不能加入目标分组');
  await assert.rejects(
    () => fixture.service.execute(rule.id, 99),
    (error) => error.code === 'GROUP_RULE_CLAIM_ONLY'
  );
  await assert.rejects(
    () => fixture.service.preview(rule.id, 99),
    (error) => error.code === 'GROUP_RULE_CLAIM_ONLY'
  );
});

test('用户申请时只实时查询当前用户并安全追加分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const rule = await fixture.service.createRule(ruleInput(5), 99);

  const result = await fixture.service.claim(rule.id, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.granted, true);
  assert.equal(result.already_granted, false);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 9]);
  assert.deepEqual(fixture.calls.getUser, [1]);
  assert.deepEqual(fixture.calls.getUserBalanceHistory, [1]);
  assert.equal(fixture.calls.listUsers, 0);
  assert.equal(fixture.calls.listRedeemCodes, 0);

  const repeated = await fixture.service.claim(rule.id, 1);
  assert.equal(repeated.already_granted, true);
  assert.deepEqual(fixture.calls.getUser, [1, 1]);
  assert.deepEqual(fixture.calls.getUserBalanceHistory, [1, 1]);
  assert.equal(fixture.updates.length, 1, '重复申请不能重复写回 Sub2API');
});

test('活动结束时恢复申请前并发数，但在撤销时间前保留分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.users.get(1).concurrency = 7;
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    concurrency_limit: 3,
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  }, 99);

  await fixture.service.claim(rule.id, 1);
  assert.equal(fixture.users.get(1).concurrency, 3);
  assert.deepEqual({ ...fixture.db.prepare(`
    SELECT original_concurrency, applied_concurrency, status
    FROM group_entitlement_concurrency_overrides
  `).get() }, { original_concurrency: 7, applied_concurrency: 3, status: 'active' });

  await fixture.service.updateRule(rule.id, {
    ...ruleInput(5),
    concurrency_limit: 3,
    activity_ends_at: '2019-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  }, 99);
  const [restored] = await fixture.service.restoreScheduledConcurrency();
  assert.equal(restored.status, 'restored');
  assert.equal(fixture.users.get(1).concurrency, 7);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 9]);
  assert.equal(fixture.db.prepare('SELECT status FROM group_entitlement_concurrency_overrides').get().status, 'restored');
  assert.deepEqual(await fixture.service.executeScheduled(), []);
});

test('多个重叠资格活动按结束顺序变化时仍恢复最初并发数', async (t) => {
  const fixture = createFixture([5, 6]);
  t.after(() => fixture.db.close());
  fixture.users.get(1).concurrency = 7;
  const first = await fixture.service.createRule({
    ...ruleInput(5),
    concurrency_limit: 3,
    activity_ends_at: '2099-01-01T00:00:00.000Z',
    revoke_at: '2099-01-03T00:00:00.000Z'
  }, 99);
  const second = await fixture.service.createRule({
    ...ruleInput(6),
    concurrency_limit: 4,
    activity_ends_at: '2099-01-02T00:00:00.000Z',
    revoke_at: '2099-01-04T00:00:00.000Z'
  }, 99);
  await fixture.service.claim(first.id, 1);
  await fixture.service.claim(second.id, 1);
  assert.equal(fixture.users.get(1).concurrency, 4);

  await fixture.service.updateRule(first.id, {
    ...ruleInput(5), concurrency_limit: 3,
    activity_ends_at: '2099-01-03T00:00:00.000Z', revoke_at: '2099-01-04T00:00:00.000Z'
  }, 99);
  await fixture.service.updateRule(second.id, {
    ...ruleInput(6), concurrency_limit: 4,
    activity_ends_at: '2019-01-01T00:00:00.000Z', revoke_at: '2099-01-04T00:00:00.000Z'
  }, 99);
  await fixture.service.restoreScheduledConcurrency();
  assert.equal(fixture.users.get(1).concurrency, 3);
  await fixture.service.updateRule(first.id, {
    ...ruleInput(5), concurrency_limit: 3,
    activity_ends_at: '2019-01-01T00:00:00.000Z', revoke_at: '2099-01-04T00:00:00.000Z'
  }, 99);
  await fixture.service.restoreScheduledConcurrency();
  assert.equal(fixture.users.get(1).concurrency, 7);
});

test('并发恢复失败后会在下一个调度周期重试', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.users.get(1).concurrency = 8;
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    concurrency_limit: 3,
    activity_ends_at: '2099-01-01T00:00:00.000Z',
    revoke_at: '2099-01-02T00:00:00.000Z'
  }, 99);
  await fixture.service.claim(rule.id, 1);
  await fixture.service.updateRule(rule.id, {
    ...ruleInput(5), concurrency_limit: 3,
    activity_ends_at: '2019-01-01T00:00:00.000Z', revoke_at: '2099-01-02T00:00:00.000Z'
  }, 99);

  fixture.failNextUpdates(1);
  const [failed] = await fixture.service.restoreScheduledConcurrency();
  assert.equal(failed.status, 'failed');
  assert.equal(fixture.users.get(1).concurrency, 3);
  const [retried] = await fixture.service.restoreScheduledConcurrency();
  assert.equal(retried.status, 'restored');
  assert.equal(fixture.users.get(1).concurrency, 8);
});

test('条件不满足时返回具体原因且不写入分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    condition: {
      type: 'group', operator: 'and', children: [
        { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 },
        { type: 'fact', fact: 'current_balance', operator: 'gte', value: 20 }
      ]
    }
  }, 99);

  const result = await fixture.service.claim(rule.id, 2);
  assert.equal(result.eligible, false);
  assert.equal(result.granted, false);
  assert.deepEqual(result.reasons, ['累计充值金额需要大于 0 元', '当前余额不足，需要至少 20 元']);
  assert.deepEqual(fixture.users.get(2).allowed_groups, []);
  assert.equal(fixture.updates.length, 0);
});

test('用户申请时按规则需要实时读取近期充值流水', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    condition: {
      type: 'fact',
      fact: 'recent_recharge_total',
      operator: 'gte',
      value: 10,
      window_days: 7
    }
  }, 99);

  const result = await fixture.service.claim(rule.id, 1);
  assert.equal(result.eligible, true);
  assert.equal(result.granted, true);
  assert.equal(result.facts.recent_recharge_totals['7'], 12);
  assert.equal(fixture.calls.getUserBalanceHistory.length, 3);
});

test('已有目标分组记为既有授权，删除规则时不会撤销', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.users.get(2).allowed_groups = [5, 8];
  fixture.users.get(2).total_recharged = 10;
  const rule = await fixture.service.createRule(ruleInput(5), 99);

  const existing = await fixture.service.claim(rule.id, 2);
  assert.equal(existing.already_granted, true);
  assert.equal(fixture.updates.length, 0);
  const deleted = await fixture.service.deleteRule(rule.id, 99);
  assert.equal(deleted.revoked_count, 0);
  assert.deepEqual(fixture.users.get(2).allowed_groups, [5, 8]);
});

test('删除规则只撤销扩展通过申请添加的目标分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const rule = await fixture.service.createRule(ruleInput(5), 99);
  await fixture.service.claim(rule.id, 1);

  const deleted = await fixture.service.deleteRule(rule.id, 99);
  assert.equal(deleted.revoked_count, 1);
  assert.equal(deleted.failed_count, 0);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9]);
  assert.deepEqual(fixture.updates, [
    { user_id: 1, allowed_groups: [5, 9] },
    { user_id: 1, allowed_groups: [9] }
  ]);
});

test('分组撤销时间到达后自动撤销且重复调度保持幂等', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const activeInput = {
    ...ruleInput(5),
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  };
  const rule = await fixture.service.createRule(activeInput, 99);
  await fixture.service.claim(rule.id, 1);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 9]);

  await fixture.service.updateRule(rule.id, {
    ...activeInput,
    activity_ends_at: '2019-01-01T00:00:00.000Z',
    revoke_at: '2020-01-01T00:00:00.000Z'
  }, 99);
  const [expired] = await fixture.service.executeScheduled();
  assert.equal(expired.mode, 'expire');
  assert.equal(expired.status, 'succeeded', expired.error);
  assert.equal(expired.revoked_count, 1);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9]);
  assert.deepEqual(await fixture.service.executeScheduled(), []);

  await assert.rejects(
    () => fixture.service.claim(rule.id, 1),
    (error) => error.code === 'GROUP_CLAIM_NOT_ACTIVE'
  );
});

test('分组撤销时间到达时不会撤销用户原本就有的目标分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.users.get(2).allowed_groups = [5, 8];
  fixture.users.get(2).total_recharged = 10;
  const activeInput = {
    ...ruleInput(5),
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  };
  const rule = await fixture.service.createRule(activeInput, 99);
  await fixture.service.claim(rule.id, 2);

  await fixture.service.updateRule(rule.id, {
    ...activeInput,
    activity_ends_at: '2019-01-01T00:00:00.000Z',
    revoke_at: '2020-01-01T00:00:00.000Z'
  }, 99);
  const [expired] = await fixture.service.executeScheduled();
  assert.equal(expired.revoked_count, 0);
  assert.deepEqual(fixture.users.get(2).allowed_groups, [5, 8]);
});

test('到期撤销失败后会在下一个调度周期重试', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const activeInput = {
    ...ruleInput(5),
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  };
  const rule = await fixture.service.createRule(activeInput, 99);
  await fixture.service.claim(rule.id, 1);
  await fixture.service.updateRule(rule.id, {
    ...activeInput,
    activity_ends_at: '2019-01-01T00:00:00.000Z',
    revoke_at: '2020-01-01T00:00:00.000Z'
  }, 99);

  fixture.failNextUpdates(1);
  const [failed] = await fixture.service.executeScheduled();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.failed_count, 1);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 9]);

  const [retried] = await fixture.service.executeScheduled();
  assert.equal(retried.status, 'succeeded');
  assert.equal(retried.revoked_count, 1);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9]);
});

test('管理员可以提前停用活动并撤销扩展发放的分组', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    activity_ends_at: '2098-01-01T00:00:00.000Z',
    revoke_at: '2099-01-01T00:00:00.000Z'
  }, 99);
  await fixture.service.claim(rule.id, 1);

  const revoked = await fixture.service.revokeNow(rule.id, 99);
  assert.equal(revoked.mode, 'revoke');
  assert.equal(revoked.revoked_count, 1);
  assert.equal(fixture.service.getRule(rule.id).enabled, false);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [9]);
});

test('管理员提前撤销时同时恢复临时并发数', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  fixture.users.get(1).concurrency = 9;
  const rule = await fixture.service.createRule({
    ...ruleInput(5),
    concurrency_limit: 3,
    activity_ends_at: '2099-01-01T00:00:00.000Z',
    revoke_at: '2099-01-02T00:00:00.000Z'
  }, 99);
  await fixture.service.claim(rule.id, 1);
  assert.equal(fixture.users.get(1).concurrency, 3);

  const revoked = await fixture.service.revokeNow(rule.id, 99);
  assert.equal(revoked.revoked_count, 1);
  assert.equal(fixture.users.get(1).concurrency, 9);
  assert.equal(fixture.db.prepare('SELECT status FROM group_entitlement_concurrency_overrides').get().status, 'restored');
});

test('分组撤销时间必须晚于活动结束时间', async (t) => {
  const fixture = createFixture();
  t.after(() => fixture.db.close());
  await assert.rejects(
    () => fixture.service.createRule({
      ...ruleInput(5),
      activity_ends_at: '2099-01-01T00:00:00.000Z',
      revoke_at: '2098-01-01T00:00:00.000Z'
    }, 99),
    (error) => error.code === 'VALIDATION_ERROR'
  );
});

test('同一用户并发申请不同分组时不会覆盖已有 allowed_groups', async (t) => {
  const fixture = createFixture([5, 6]);
  t.after(() => fixture.db.close());
  const first = await fixture.service.createRule(ruleInput(5), 99);
  const second = await fixture.service.createRule(ruleInput(6), 99);

  await Promise.all([
    fixture.service.claim(first.id, 1),
    fixture.service.claim(second.id, 1)
  ]);
  assert.deepEqual(fixture.users.get(1).allowed_groups, [5, 6, 9]);
});

test('数据库升级会把旧自动规则转换为手动申请', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sub2api-extension-db-'));
  const path = join(directory, 'extension.sqlite');
  try {
    let db = openDatabase(path);
    db.prepare(`
      INSERT INTO group_entitlement_rules(
        name, group_id, enabled, revoke_when_ineligible, condition_json,
        assignment_mode, created_by, created_at, updated_at
      ) VALUES ('旧自动规则', 5, 1, 1, '{"op":"all","children":[]}', 'automatic', 1, ?, ?)
    `).run(new Date().toISOString(), new Date().toISOString());
    db.exec('PRAGMA user_version = 8');
    db.close();

    db = openDatabase(path);
    const row = db.prepare('SELECT assignment_mode, revoke_when_ineligible FROM group_entitlement_rules').get();
    assert.deepEqual({ ...row }, { assignment_mode: 'claim', revoke_when_ineligible: 0 });
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 14);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createFixture(groupIds = [5]) {
  const db = openDatabase(':memory:');
  const users = new Map([
    [1, user(1, 100, 0, [9])],
    [2, user(2, 5, 0, [])]
  ]);
  const updates = [];
  let updateFailuresRemaining = 0;
  const calls = { listUsers: 0, listRedeemCodes: 0, getUser: [], getUserBalanceHistory: [] };
  const client = {
    async listGroups() {
      return groupIds.map((id) => ({
        id, name: `分组 ${id}`, status: 'active', is_exclusive: true, rate_multiplier: 0.01
      }));
    },
    async listUsers() {
      calls.listUsers += 1;
      return { items: [...users.values()].map(clone), pages: 1 };
    },
    async listRedeemCodes() {
      calls.listRedeemCodes += 1;
      return { items: [], pages: 1 };
    },
    async getUser(userId) {
      const id = Number(userId);
      calls.getUser.push(id);
      return clone(users.get(id));
    },
    async getUserBalanceHistory(userId, options = {}) {
      const id = Number(userId);
      calls.getUserBalanceHistory.push(id);
      if (options.pageSize) {
        if (id === 1 && options.type === 'balance') {
          return {
            items: [{
              id: 100,
              code: 'RECENT-100',
              type: 'balance',
              value: 12,
              status: 'used',
              used_by: 1,
              used_at: new Date().toISOString(),
              notes: ''
            }],
            pages: 1,
            total_recharged: 50
          };
        }
        return { items: [], pages: 1, total_recharged: id === 1 ? 50 : 0 };
      }
      return { items: [], total: 0, total_recharged: id === 1 ? 50 : 0 };
    },
    async updateUserAllowedGroups(userId, allowedGroups, concurrency = undefined) {
      if (updateFailuresRemaining > 0) {
        updateFailuresRemaining -= 1;
        throw new Error('模拟 Sub2API 更新失败');
      }
      const id = Number(userId);
      users.get(id).allowed_groups = [...allowedGroups];
      if (concurrency !== undefined) users.get(id).concurrency = Number(concurrency);
      updates.push({
        user_id: id,
        allowed_groups: [...allowedGroups],
        ...(concurrency !== undefined ? { concurrency: Number(concurrency) } : {})
      });
      return clone(users.get(id));
    },
    async updateUserConcurrency(userId, concurrency) {
      if (updateFailuresRemaining > 0) {
        updateFailuresRemaining -= 1;
        throw new Error('模拟 Sub2API 更新失败');
      }
      const id = Number(userId);
      users.get(id).concurrency = Number(concurrency);
      updates.push({ user_id: id, concurrency: Number(concurrency) });
      return clone(users.get(id));
    }
  };
  const sync = new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' });
  const service = new GroupEntitlementService(db, client, sync);
  return {
    db,
    users,
    updates,
    calls,
    service,
    failNextUpdates(count) { updateFailuresRemaining = Number(count) || 0; }
  };
}

function ruleInput(groupId) {
  return {
    name: `分组 ${groupId} 资格`,
    group_id: groupId,
    enabled: true,
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: '充值用户可申请',
    condition: { type: 'fact', fact: 'has_recharged', operator: 'eq', value: true }
  };
}

function user(id, balance, totalRecharged, allowedGroups) {
  return {
    id,
    email: `u${id}@example.com`,
    username: `u${id}`,
    role: 'user',
    status: 'active',
    balance,
    total_recharged: totalRecharged,
    allowed_groups: [...allowedGroups],
    concurrency: 0,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-07-31T00:00:00Z'
  };
}

function clone(value) {
  return structuredClone(value);
}
