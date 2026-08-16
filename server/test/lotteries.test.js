import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDatabase } from '../src/db.js';
import { LotteryService } from '../src/lotteries.js';
import { OutboxService } from '../src/outbox.js';
import { upsertSyncedUser } from '../src/sync.js';

test('数据库升级会把旧抽奖迁移为未启动或进行中', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sub2api-extension-lottery-db-'));
  const path = join(directory, 'extension.sqlite');
  try {
    let db = openDatabase(path);
    const timestamp = new Date().toISOString();
    const insert = db.prepare(`
      INSERT INTO lotteries(name, description, status, rule_json, published, created_by, created_at, updated_at)
      VALUES (?, '', 'draft', '{"op":"all","children":[]}', ?, 1, ?, ?)
    `);
    insert.run('旧未发布抽奖', 0, timestamp, timestamp);
    insert.run('旧已发布抽奖', 1, timestamp, timestamp);
    db.exec('PRAGMA user_version = 9');
    db.close();

    db = openDatabase(path);
    assert.deepEqual(
      db.prepare('SELECT name, status FROM lotteries ORDER BY id').all().map((row) => ({ ...row })),
      [
        { name: '旧未发布抽奖', status: 'not_started' },
        { name: '旧已发布抽奖', status: 'active' }
      ]
    );
    assert.equal(db.prepare('PRAGMA user_version').get().user_version, 13);
    db.close();
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('参与抽奖只刷新当前用户且开奖沿用参与时资格', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  let currentBalance = 25;
  let refreshed = 0;
  const sync = {
    async run() { throw new Error('不应执行全量同步'); },
    async refreshUser(userId) {
      refreshed += 1;
      upsertSyncedUser(db, {
        id: userId,
        email: 'live@example.com',
        role: 'user',
        status: 'active',
        balance: currentBalance,
        total_recharged: 10,
        allowed_groups: [],
        created_at: '2026-01-01T00:00:00Z'
      });
      return db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    }
  };
  const service = new LotteryService(db, sync, { rewardCodePrefix: 'S2EXT-' });
  const lottery = service.create({
    name: '实时资格抽奖', description: '', published: true,
    condition: { type: 'fact', fact: 'current_balance', operator: 'gte', value: 20 },
    prizes: [{ name: '测试奖品', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 0 }]
  }, 99);

  assert.equal(lottery.status, 'not_started');
  await assert.rejects(() => service.participate(lottery.id, 1), (error) => error.code === 'NOT_FOUND');
  assert.equal(service.start(lottery.id, 99).status, 'active');

  const entry = await service.participate(lottery.id, 1);
  assert.equal(entry.participated, true);
  assert.equal(refreshed, 1);
  currentBalance = 0;

  const updated = service.update(lottery.id, {
    name: '编辑后的实时资格抽奖',
    description: '进行中修改配置',
    starts_at: null,
    ends_at: null,
    auto_draw_at: null,
    condition: { type: 'fact', fact: 'current_balance', operator: 'gte', value: 999 },
    prizes: [{ name: '编辑后的奖品', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 0 }]
  }, 99);
  assert.equal(updated.status, 'active', '进行中编辑不能把抽奖重置为未启动');
  assert.equal(updated.published, true);
  assert.equal(updated.entry_count, 1, '进行中编辑必须保留原有参与记录');
  assert.equal(updated.prizes[0].name, '编辑后的奖品');

  const repeated = await service.participate(lottery.id, 1);
  assert.equal(repeated.participated, true, '原参与者在条件变更后仍保持参与');
  assert.equal(refreshed, 1, '原参与者不应因编辑配置而重新校验资格');
  const snapshot = await service.generateSnapshot(lottery.id, 99);
  assert.equal(snapshot.candidate_count, 1, '编辑条件和余额变化不能取消已经成功参与的资格');
  await service.lock(lottery.id, 99);
  assert.equal(refreshed, 1, '生成和锁定名单不应再次查询用户或执行全量同步');
});

test('进行中的抽奖可以删除并清理参与记录', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sync = {
    async refreshUser(userId) {
      upsertSyncedUser(db, {
        id: userId,
        email: 'delete@example.com',
        role: 'user',
        status: 'active',
        balance: 10,
        total_recharged: 10,
        allowed_groups: [],
        created_at: '2026-01-01T00:00:00Z'
      });
      return db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    }
  };
  const service = new LotteryService(db, sync, { rewardCodePrefix: 'S2EXT-' });
  const lottery = service.create({
    name: '可删除抽奖',
    description: '',
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '测试奖品', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 0 }]
  }, 99);
  service.start(lottery.id, 99);
  await service.participate(lottery.id, 1);

  service.delete(lottery.id, 99);

  assert.throws(() => service.get(lottery.id), (error) => error.code === 'NOT_FOUND');
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lottery_entries').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM prizes').get().count, 0);
});

test('已完成抽奖可以删除全部开奖记录但未完成发奖时不能删除', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const sync = {
    async refreshUser(userId) {
      upsertSyncedUser(db, {
        id: userId,
        email: 'fulfilled-delete@example.com',
        role: 'user',
        status: 'active',
        balance: 10,
        total_recharged: 10,
        allowed_groups: [],
        created_at: '2026-01-01T00:00:00Z'
      });
      return db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    }
  };
  const service = new LotteryService(db, sync, { rewardCodePrefix: 'S2EXT-' });
  const outbox = new OutboxService(db, {}, { outboxIntervalMs: 10_000 });
  const lottery = service.create({
    name: '已完成可删除抽奖',
    description: '',
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '人工奖品', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 0 }]
  }, 99);
  service.start(lottery.id, 99);
  await service.participate(lottery.id, 1);
  await service.drawNow(lottery.id, 99, 'fulfilled-delete-draw');

  assert.throws(
    () => service.delete(lottery.id, 99),
    (error) => error.code === 'LOTTERY_NOT_DELETABLE',
    '尚未完成发奖的抽奖不能删除'
  );
  const job = outbox.listForLottery(lottery.id).items[0];
  outbox.completeManual(job.id, 99, 'delivered');
  assert.equal(service.get(lottery.id).status, 'fulfilled');

  service.delete(lottery.id, 99);

  assert.throws(() => service.get(lottery.id), (error) => error.code === 'NOT_FOUND');
  for (const table of ['lottery_entries', 'candidate_snapshots', 'prizes', 'draw_rounds', 'winners', 'outbox_jobs']) {
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get().count, 0, `${table} 应清空`);
  }
  const deletedAudit = db.prepare("SELECT details_json FROM audit_events WHERE action = 'lottery.deleted' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(deletedAudit.details_json), {
    previous_status: 'fulfilled',
    entry_count: 1,
    winner_count: 1,
    reward_job_count: 1
  });
});

test('抽奖使用锁定快照、无放回抽取和幂等开奖', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  for (let id = 1; id <= 5; id += 1) {
    upsertSyncedUser(db, {
      id, email: `u${id}@example.com`, role: 'user', status: 'active', balance: id * 10,
      total_recharged: id === 1 ? 0 : 10, created_at: '2026-01-01T00:00:00Z'
    });
    if (id > 1) db.prepare(`
      INSERT INTO recharge_events(source_type, source_id, user_id, value_cents, used_at, code, notes, synced_at)
      VALUES ('balance', ?, ?, '1000', '2026-07-01T00:00:00Z', ?, '', '2026-07-01T00:00:00Z')
    `).run(String(id), id, `CODE-${id}`);
  }
  const service = new LotteryService(db, { run: async () => ({ users_scanned: 5 }) }, { rewardCodePrefix: 'S2EXT-' });
  const lottery = service.create({
    name: '夏日抽奖', description: '', published: true,
    condition: {
      type: 'group', operator: 'and', children: [
        { type: 'fact', fact: 'current_balance', operator: 'gte', value: 20 },
        { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 }
      ]
    },
    prizes: [
      { name: '一等奖', winner_count: 1, reward_type: 'balance', reward_value: 8.88, sort_order: 0 },
      { name: '纪念奖', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 1 }
    ]
  }, 99);
  service.start(lottery.id, 99);
  const denied = await service.participate(lottery.id, 1);
  assert.equal(denied.participated, false);
  assert.deepEqual(denied.reasons, ['当前余额不足，需要至少 20 元', '累计充值金额需要大于 0 元']);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lottery_entries WHERE user_id = 1').get().count, 0);

  for (const userId of [2, 3, 4]) {
    const entry = await service.participate(lottery.id, userId);
    assert.equal(entry.participated, true);
  }
  const repeated = await service.participate(lottery.id, 2);
  assert.equal(repeated.participated, true);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM lottery_entries').get().count, 3);

  const snapshot = await service.generateSnapshot(lottery.id, 99);
  assert.equal(snapshot.entry_count, 3);
  assert.equal(snapshot.candidate_count, 3);
  assert.equal(snapshot.excluded_count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM candidate_snapshots WHERE user_id = 5').get().count, 0, '未参与用户不能进入候选快照');
  await assert.rejects(() => service.participate(lottery.id, 5), (error) => error.code === 'LOTTERY_ENTRY_CLOSED');
  await service.lock(lottery.id, 99);
  const first = service.draw(lottery.id, 99, 'draw-request-1');
  const replay = service.draw(lottery.id, 99, 'draw-request-1');
  assert.equal(first.status, 'drawn');
  assert.deepEqual(replay.winners.map((winner) => winner.id), first.winners.map((winner) => winner.id));
  assert.equal(first.winners.length, 2);
  assert.equal(new Set(first.winners.map((winner) => winner.user_id)).size, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM draw_rounds').get().count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM outbox_jobs').get().count, 2);

  const rewardCalls = [];
  const outbox = new OutboxService(db, {
    async createAndRedeem(payload, idempotencyKey) {
      rewardCalls.push({ payload, idempotencyKey });
      return { redeem_code: { id: 88, code: payload.code } };
    }
  }, { outboxIntervalMs: 10_000 });
  await outbox.processLottery(lottery.id);
  await outbox.processLottery(lottery.id);
  assert.equal(rewardCalls.length, 1, '已成功发放的奖励不重复调用上游');
  assert.match(rewardCalls[0].payload.code, /^S2EXT-/);
  assert.match(rewardCalls[0].payload.notes, /sub2api-extension reward:/);
  assert.match(rewardCalls[0].idempotencyKey, /^sub2api-extension-reward-/);
  const jobStatuses = db.prepare('SELECT status FROM outbox_jobs ORDER BY id').all().map((row) => row.status).sort();
  assert.deepEqual(jobStatuses, ['manual', 'succeeded']);
});

test('到达自动开奖时间后停止参与并完成开奖', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  for (let id = 1; id <= 3; id += 1) {
    upsertSyncedUser(db, {
      id, email: `auto${id}@example.com`, role: 'user', status: 'active', balance: 10,
      total_recharged: 10, created_at: '2026-01-01T00:00:00Z'
    });
  }
  const service = new LotteryService(db, { run: async () => ({ users_scanned: 3 }) }, {
    rewardCodePrefix: 'S2EXT-', autoDrawIntervalMs: 10_000
  });
  const lottery = service.create({
    name: '定时抽奖', description: '', published: true,
    auto_draw_at: new Date(Date.now() + 60_000).toISOString(),
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '余额奖', winner_count: 1, reward_type: 'balance', reward_value: 5, sort_order: 0 }]
  }, 99);
  service.start(lottery.id, 99);
  await service.participate(lottery.id, 1);
  await service.participate(lottery.id, 2);
  db.prepare('UPDATE lotteries SET auto_draw_at = ? WHERE id = ?')
    .run(new Date(Date.now() - 1_000).toISOString(), lottery.id);

  await assert.rejects(
    () => service.participate(lottery.id, 3),
    (error) => error.code === 'LOTTERY_NOT_ACTIVE' && /等待开奖/.test(error.message)
  );
  const result = await service.processDueAutoDraws();
  const drawn = service.get(lottery.id);
  assert.deepEqual(result, { processed: 1, succeeded: 1, failed: 0 });
  assert.equal(drawn.status, 'drawn');
  assert.equal(drawn.winners.length, 1);
  assert.ok(drawn.auto_draw_attempted_at);
  assert.equal(drawn.auto_draw_error, undefined);
});

test('自动开奖失败会保存原因且不重复执行', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const service = new LotteryService(db, { run: async () => ({ users_scanned: 0 }) }, {
    rewardCodePrefix: 'S2EXT-', autoDrawIntervalMs: 10_000
  });
  const lottery = service.create({
    name: '人数不足', description: '', published: true,
    auto_draw_at: new Date(Date.now() - 1_000).toISOString(),
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '余额奖', winner_count: 1, reward_type: 'balance', reward_value: 5, sort_order: 0 }]
  }, 99);
  service.start(lottery.id, 99);

  assert.deepEqual(await service.processDueAutoDraws(), { processed: 1, succeeded: 0, failed: 1 });
  assert.equal(service.get(lottery.id).status, 'active', '人数不足时应恢复为进行中，允许继续参与');
  assert.match(service.get(lottery.id).auto_draw_error, /少于计划中奖人数/);
  assert.deepEqual(await service.processDueAutoDraws(), { processed: 0, succeeded: 0, failed: 0 });
});

test('余额、并发额度和订阅自动发放，实体奖品转人工处理', async (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  for (let id = 1; id <= 4; id += 1) {
    upsertSyncedUser(db, {
      id, email: `reward${id}@example.com`, role: 'user', status: 'active', balance: 10,
      total_recharged: 10, created_at: '2026-01-01T00:00:00Z'
    });
  }
  const service = new LotteryService(db, { run: async () => ({ users_scanned: 4 }) }, { rewardCodePrefix: 'S2EXT-' });
  const lottery = service.create({
    name: '多类型奖品', description: '', published: true,
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [
      { name: '余额', winner_count: 1, reward_type: 'balance', reward_value: 8, sort_order: 0 },
      { name: '并发', winner_count: 1, reward_type: 'concurrency', reward_value: 2, sort_order: 1 },
      { name: '订阅', winner_count: 1, reward_type: 'subscription', reward_value: 1, group_id: 7, validity_days: 30, sort_order: 2 },
      { name: '实体', winner_count: 1, reward_type: 'physical', reward_value: 0, sort_order: 3 }
    ]
  }, 99);
  service.start(lottery.id, 99);
  for (let id = 1; id <= 4; id += 1) await service.participate(lottery.id, id);
  const drawn = await service.drawNow(lottery.id, 99, 'all-reward-types');

  assert.equal(drawn.status, 'drawn');
  assert.deepEqual(
    db.prepare('SELECT job_type, status FROM outbox_jobs ORDER BY id').all().map((row) => ({ ...row })),
    [
      { job_type: 'balance', status: 'pending' },
      { job_type: 'concurrency', status: 'pending' },
      { job_type: 'subscription', status: 'pending' },
      { job_type: 'physical', status: 'manual' }
    ]
  );
  const subscriptionPayload = JSON.parse(db.prepare("SELECT payload_json FROM outbox_jobs WHERE job_type = 'subscription'").get().payload_json);
  assert.equal(subscriptionPayload.group_id, 7);
  assert.equal(subscriptionPayload.validity_days, 30);
});
