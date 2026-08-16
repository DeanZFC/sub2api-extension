import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { getRechargeSummary, shouldIncludeRecharge, SyncService } from '../src/sync.js';

test('单用户刷新合并详情充值与余额历史累计值', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const calls = [];
  const client = {
    async getUser(userId) {
      calls.push(['user', Number(userId)]);
      return {
        id: Number(userId), email: 'u@example.com', role: 'user', status: 'active',
        balance: 88, total_recharged: 0, allowed_groups: [], created_at: '2026-01-01T00:00:00Z'
      };
    },
    async getUserBalanceHistory(userId) {
      calls.push(['history', Number(userId)]);
      return { items: [], total: 0, total_recharged: 100 };
    }
  };
  const user = await new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' }).refreshUser(7);
  assert.deepEqual(calls.sort(), [['history', 7], ['user', 7]]);
  assert.equal(user.balance_cents, '8800');
  assert.equal(user.total_recharged_cents, '10000');
});

test('单用户按最大时间窗口分页刷新近期充值流水', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const now = new Date('2026-08-08T12:00:00.000Z');
  const calls = [];
  const item = (id, type, value, usedAt, extra = {}) => ({
    id,
    code: `${type}-${id}`,
    type,
    value,
    status: 'used',
    used_by: 7,
    used_at: usedAt,
    notes: '',
    ...extra
  });
  const client = {
    async getUser() {
      return {
        id: 7, email: 'u@example.com', role: 'user', status: 'active', balance: 20,
        total_recharged: 0, allowed_groups: [], created_at: '2026-01-01T00:00:00Z'
      };
    },
    async getUserBalanceHistory(userId, options = {}) {
      calls.push({ userId, ...options });
      if (!options.pageSize) return { items: [], pages: 1, total_recharged: 100 };
      if (options.type === 'admin_balance') {
        return {
          items: [item(20, 'admin_balance', 3, '2026-08-06T12:00:00Z')],
          pages: 1,
          total_recharged: 100
        };
      }
      if (options.page === 1) {
        return {
          items: [
            item(10, 'balance', 6, '2026-08-03T12:00:00Z'),
            item(11, 'balance', 5, '2026-07-20T12:00:00Z'),
            item(12, 'balance', 100, '2026-08-07T12:00:00Z', { code: 'S2EXT-REWARD' })
          ],
          pages: 2,
          total_recharged: 100
        };
      }
      return {
        items: [item(13, 'balance', 50, '2026-06-01T12:00:00Z')],
        pages: 2,
        total_recharged: 100
      };
    }
  };

  await new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' }).refreshUser(7, {
    rechargeWindowDays: [7, 30],
    now
  });
  const summary = getRechargeSummary(db, 7, { windowDays: [7, 30], now });
  assert.deepEqual(summary.recent_recharge_totals_cents, {
    '7': '900',
    '30': '1400'
  });
  assert.equal(summary.recharge_count, 3);
  assert.equal(calls.filter((call) => call.type === 'balance').length, 2);
  assert.equal(calls.filter((call) => call.type === 'admin_balance').length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS count FROM recharge_events WHERE code LIKE 'S2EXT-%'").get().count, 0);
});

test('充值同步过滤非正数、未使用和扩展奖励码', () => {
  const base = {
    id: 1, code: 'NORMAL', type: 'balance', status: 'used', used_by: 9,
    used_at: '2026-07-31T00:00:00Z', value: 10, notes: ''
  };
  assert.equal(shouldIncludeRecharge(base, 'S2EXT-'), true);
  assert.equal(shouldIncludeRecharge({ ...base, type: 'admin_balance' }, 'S2EXT-'), true);
  assert.equal(shouldIncludeRecharge({ ...base, value: 0 }, 'S2EXT-'), false);
  assert.equal(shouldIncludeRecharge({ ...base, status: 'unused' }, 'S2EXT-'), false);
  assert.equal(shouldIncludeRecharge({ ...base, code: 's2ext-ABC' }, 'S2EXT-'), false);
  assert.equal(shouldIncludeRecharge({ ...base, notes: '[sub2api-extension reward:7]' }, 'S2EXT-'), false);
  assert.equal(shouldIncludeRecharge({ ...base, type: 'subscription' }, 'S2EXT-'), false);
});

test('兑换码同步使用 used_at+id 水位停止旧页扫描', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let round = 1;
  const calls = [];
  const old = {
    id: 10, code: 'OLD', type: 'balance', status: 'used', used_by: 1, value: 5,
    used_at: '2026-07-30T00:00:00Z', notes: ''
  };
  const client = {
    async listGroups() { return []; },
    async listUsers() {
      return {
        items: [{ id: 1, email: 'u@example.com', role: 'user', status: 'active', balance: 10, total_recharged: 5, created_at: '2026-01-01T00:00:00Z' }],
        pages: 1
      };
    },
    async listRedeemCodes(type, page) {
      calls.push({ round, type, page });
      if (type === 'admin_balance') return { items: [], pages: 1 };
      if (round === 1) return { items: [old], pages: 3 };
      return {
        items: [{ ...old, id: 11, code: 'NEW', used_at: '2026-07-31T00:00:00Z' }, old],
        pages: 3
      };
    }
  };
  const service = new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' });
  await service.run();
  round = 2;
  await service.run();
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM recharge_events').get().count, 2);
  assert.equal(calls.filter((call) => call.round === 2 && call.type === 'balance').length, 1);
  const cursor = JSON.parse(db.prepare("SELECT cursor_json FROM sync_cursors WHERE source = 'redeem:balance'").get().cursor_json);
  assert.deepEqual(cursor, { used_at: '2026-07-31T00:00:00.000Z', id: 11 });
});

test('同一 used_at 下只同步水位 id 之后的新记录', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let round = 1;
  const usedAt = '2026-07-31T00:00:00Z';
  const code = (id) => ({
    id, code: `CODE-${id}`, type: 'balance', status: 'used', used_by: 1,
    value: 5, used_at: usedAt, notes: ''
  });
  const client = {
    async listGroups() { return []; },
    async listUsers() {
      return {
        items: [{
          id: 1, email: 'u@example.com', role: 'user', status: 'active', balance: 10,
          total_recharged: 5, created_at: '2026-01-01T00:00:00Z'
        }],
        pages: 1
      };
    },
    async listRedeemCodes(type) {
      if (type === 'admin_balance') return { items: [], pages: 1 };
      return round === 1
        ? { items: [code(10), code(9)], pages: 1 }
        : { items: [code(12), code(11), code(10), code(9)], pages: 1 };
    }
  };
  const service = new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' });
  await service.run();
  round = 2;
  await service.run();

  assert.deepEqual(
    db.prepare('SELECT source_id FROM recharge_events ORDER BY source_id').all().map((row) => row.source_id),
    ['10', '11', '12', '9']
  );
});

test('分组同步会读取全部分页后再清理旧快照', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const pages = [];
  const client = {
    async listGroups(page) {
      pages.push(page);
      return page === 1
        ? {
            items: [{ id: 5, name: 'G5', status: 'active', is_exclusive: true, rate_multiplier: 1 }],
            pages: 2
          }
        : {
            items: [{ id: 6, name: 'G6', status: 'disabled', is_exclusive: true, rate_multiplier: 0.5 }],
            pages: 2
          };
    },
    async listUsers() { return { items: [], pages: 1 }; },
    async listRedeemCodes() { return { items: [], pages: 1 }; }
  };
  await new SyncService(db, client, { rewardCodePrefix: 'S2EXT-' }).run();

  assert.deepEqual(pages, [1, 2]);
  assert.deepEqual(
    db.prepare('SELECT group_id, status FROM synced_groups ORDER BY group_id').all().map((row) => ({ ...row })),
    [{ group_id: 5, status: 'active' }, { group_id: 6, status: 'disabled' }]
  );
});
