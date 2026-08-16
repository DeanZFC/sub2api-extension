import { createHash } from 'node:crypto';
import { audit, nowIso, parseJson, transaction } from './db.js';
import { conflict, notFound } from './errors.js';
import { assertDecimalString } from './money.js';
import {
  conditionFromApi,
  conditionToApi,
  evaluateRule,
  factsToApi,
  makeUserFacts,
  rechargeWindowDays
} from './rules.js';
import { randomUnique } from './random.js';
import { getRechargeSummary } from './sync.js';
import { integer, objectBody, optionalString, positiveId, requiredString } from './validation.js';

const REWARD_TYPES = new Set(['manual', 'physical', 'balance', 'concurrency', 'subscription']);
const MUTABLE_STATUSES = new Set(['not_started', 'active']);
const DELETABLE_STATUSES = new Set([...MUTABLE_STATUSES, 'fulfilled']);

export class LotteryService {
  constructor(db, syncService, config) {
    this.db = db;
    this.syncService = syncService;
    this.config = config;
    this.generating = new Set();
    this.autoDrawTimer = null;
    this.autoDrawing = false;
  }

  list() {
    const rows = this.db.prepare('SELECT * FROM lotteries ORDER BY id DESC').all();
    return { items: rows.map((row) => this.#toApi(row, false)), total: rows.length };
  }

  get(idValue) {
    const id = positiveId(idValue);
    const row = this.db.prepare('SELECT * FROM lotteries WHERE id = ?').get(id);
    if (!row) throw notFound('抽奖活动');
    return this.#toApi(row, true);
  }

  create(input, actorUserId) {
    const value = normalizeLotteryInput(input);
    const timestamp = nowIso();
    const id = transaction(this.db, () => {
      const result = this.db.prepare(`
        INSERT INTO lotteries(
          name, description, status, rule_json, published, starts_at, ends_at,
          auto_draw_at, created_by, created_at, updated_at
        ) VALUES (?, ?, 'not_started', ?, 0, ?, ?, ?, ?, ?, ?)
      `).run(
        value.name, value.description, JSON.stringify(value.rule),
        value.starts_at, value.ends_at, value.auto_draw_at, actorUserId, timestamp, timestamp
      );
      const lotteryId = Number(result.lastInsertRowid);
      value.prizes.forEach((prize, index) => insertPrize(this.db, lotteryId, prize, index, timestamp));
      audit(this.db, actorUserId, 'lottery.created', 'lottery', lotteryId, { prize_count: value.prizes.length });
      return lotteryId;
    });
    return this.get(id);
  }

  update(idValue, input, actorUserId) {
    const id = positiveId(idValue);
    const existing = this.#row(id);
    if (!MUTABLE_STATUSES.has(existing.status)) throw conflict('LOTTERY_NOT_EDITABLE', '开奖处理开始后不能修改活动');
    const value = normalizeLotteryInput(input, existing);
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE lotteries SET name = ?, description = ?, rule_json = ?,
          starts_at = ?, ends_at = ?, auto_draw_at = ?, updated_at = ?,
          candidates_generated_at = NULL, locked_at = NULL, auto_draw_attempted_at = NULL,
          auto_draw_error = NULL WHERE id = ?
      `).run(
        value.name, value.description, JSON.stringify(value.rule),
        value.starts_at, value.ends_at, value.auto_draw_at, nowIso(), id
      );
      this.db.prepare('DELETE FROM candidate_snapshots WHERE lottery_id = ?').run(id);
      this.db.prepare('DELETE FROM prizes WHERE lottery_id = ?').run(id);
      value.prizes.forEach((prize, index) => insertPrize(this.db, id, prize, index, nowIso()));
      const entryCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM lottery_entries WHERE lottery_id = ?').get(id).count);
      audit(this.db, actorUserId, 'lottery.updated', 'lottery', id, {
        prize_count: value.prizes.length,
        preserved_entry_count: entryCount,
        status: existing.status
      });
    });
    return this.get(id);
  }

  start(idValue, actorUserId) {
    const id = positiveId(idValue);
    const row = this.#row(id);
    if (row.status === 'active') return this.get(id);
    if (row.status !== 'not_started') {
      throw conflict('LOTTERY_NOT_STARTABLE', '当前抽奖不能启动');
    }
    const timestamp = nowIso();
    const result = this.db.prepare(`
      UPDATE lotteries SET status = 'active', published = 1, updated_at = ?
      WHERE id = ? AND status = 'not_started'
    `).run(timestamp, id);
    if (Number(result.changes) !== 1) throw conflict('LOTTERY_NOT_STARTABLE', '抽奖状态已发生变化');
    audit(this.db, actorUserId, 'lottery.started', 'lottery', id);
    return this.get(id);
  }

  delete(idValue, actorUserId) {
    const id = positiveId(idValue);
    const row = this.#row(id);
    if (!DELETABLE_STATUSES.has(row.status)) {
      throw conflict('LOTTERY_NOT_DELETABLE', '只能删除未启动、进行中或已完成的抽奖');
    }
    transaction(this.db, () => {
      const entryCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM lottery_entries WHERE lottery_id = ?').get(id).count);
      const winnerCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM winners WHERE lottery_id = ?').get(id).count);
      const jobCount = Number(this.db.prepare(`
        SELECT COUNT(*) AS count FROM outbox_jobs
        WHERE winner_id IN (SELECT id FROM winners WHERE lottery_id = ?)
      `).get(id).count);
      this.db.prepare(`
        DELETE FROM outbox_jobs WHERE winner_id IN (SELECT id FROM winners WHERE lottery_id = ?)
      `).run(id);
      this.db.prepare('DELETE FROM winners WHERE lottery_id = ?').run(id);
      this.db.prepare('DELETE FROM draw_rounds WHERE lottery_id = ?').run(id);
      this.db.prepare('DELETE FROM lotteries WHERE id = ?').run(id);
      audit(this.db, actorUserId, 'lottery.deleted', 'lottery', id, {
        previous_status: row.status,
        entry_count: entryCount,
        winner_count: winnerCount,
        reward_job_count: jobCount
      });
    });
  }

  addPrize(lotteryIdValue, input, actorUserId) {
    const lotteryId = positiveId(lotteryIdValue);
    const row = this.#row(lotteryId);
    if (!MUTABLE_STATUSES.has(row.status)) throw conflict('LOTTERY_NOT_EDITABLE', '开奖处理开始后不能修改奖项');
    const prize = normalizePrize(input);
    const id = transaction(this.db, () => {
      this.#invalidateSnapshot(lotteryId);
      const sortOrder = Number(this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) + 1 AS value FROM prizes WHERE lottery_id = ?').get(lotteryId).value);
      const prizeId = insertPrize(this.db, lotteryId, prize, sortOrder, nowIso());
      audit(this.db, actorUserId, 'prize.created', 'prize', prizeId, { lottery_id: lotteryId });
      return prizeId;
    });
    return this.getPrize(id);
  }

  replacePrizes(lotteryIdValue, input, actorUserId) {
    const lotteryId = positiveId(lotteryIdValue);
    const lottery = this.#row(lotteryId);
    if (!MUTABLE_STATUSES.has(lottery.status)) throw conflict('LOTTERY_NOT_EDITABLE', '开奖处理开始后不能修改奖项');
    const body = objectBody(input);
    if (!Array.isArray(body.prizes) || body.prizes.length === 0 || body.prizes.length > 50) {
      throw conflict('PRIZES_REQUIRED', '奖项数量必须为 1 至 50');
    }
    const prizes = body.prizes.map(normalizePrize);
    transaction(this.db, () => {
      this.#invalidateSnapshot(lotteryId);
      this.db.prepare('DELETE FROM prizes WHERE lottery_id = ?').run(lotteryId);
      prizes.forEach((prize, index) => insertPrize(this.db, lotteryId, prize, index, nowIso()));
      audit(this.db, actorUserId, 'prizes.replaced', 'lottery', lotteryId, { prize_count: prizes.length });
    });
    return this.get(lotteryId);
  }

  updatePrize(prizeIdValue, input, actorUserId) {
    const prizeId = positiveId(prizeIdValue);
    const existing = this.db.prepare('SELECT * FROM prizes WHERE id = ?').get(prizeId);
    if (!existing) throw notFound('奖项');
    const lottery = this.#row(existing.lottery_id);
    if (!MUTABLE_STATUSES.has(lottery.status)) throw conflict('LOTTERY_NOT_EDITABLE', '开奖处理开始后不能修改奖项');
    const prize = normalizePrize(input);
    transaction(this.db, () => {
      this.#invalidateSnapshot(existing.lottery_id);
      this.db.prepare(`
        UPDATE prizes SET name = ?, winner_count = ?, reward_type = ?, reward_value = ?,
          group_id = ?, validity_days = ?, sort_order = ?, updated_at = ? WHERE id = ?
      `).run(
        prize.name, prize.winner_count, prize.reward_type, prize.reward_value, prize.group_id,
        prize.validity_days, prize.sort_order ?? existing.sort_order, nowIso(), prizeId
      );
      audit(this.db, actorUserId, 'prize.updated', 'prize', prizeId, { lottery_id: existing.lottery_id });
    });
    return this.getPrize(prizeId);
  }

  deletePrize(prizeIdValue, actorUserId) {
    const prizeId = positiveId(prizeIdValue);
    const existing = this.db.prepare('SELECT * FROM prizes WHERE id = ?').get(prizeId);
    if (!existing) throw notFound('奖项');
    const lottery = this.#row(existing.lottery_id);
    if (!MUTABLE_STATUSES.has(lottery.status)) throw conflict('LOTTERY_NOT_EDITABLE', '开奖处理开始后不能修改奖项');
    transaction(this.db, () => {
      this.#invalidateSnapshot(existing.lottery_id);
      this.db.prepare('DELETE FROM prizes WHERE id = ?').run(prizeId);
      audit(this.db, actorUserId, 'prize.deleted', 'prize', prizeId, { lottery_id: existing.lottery_id });
    });
  }

  getPrize(idValue) {
    const row = this.db.prepare('SELECT * FROM prizes WHERE id = ?').get(positiveId(idValue));
    if (!row) throw notFound('奖项');
    return prizeToApi(row);
  }

  async participate(idValue, userIdValue) {
    const id = positiveId(idValue);
    const userId = positiveId(userIdValue, 'user_id');
    let lottery = this.#row(id);
    if (!lottery.published) throw notFound('抽奖活动');

    const existing = this.db.prepare('SELECT * FROM lottery_entries WHERE lottery_id = ? AND user_id = ?').get(id, userId);
    if (existing) return entryResult(existing, true);
    if (lottery.status !== 'active') throw conflict('LOTTERY_ENTRY_CLOSED', '抽奖参与已结束，正在处理开奖结果');
    const window = lotteryWindowStatus(lottery.starts_at, lottery.ends_at, lottery.auto_draw_at);
    if (window !== 'active') {
      throw conflict('LOTTERY_NOT_ACTIVE', window === 'upcoming' ? '抽奖活动尚未开始' : '抽奖参与已结束，等待开奖');
    }

    let user;
    const rule = parseJson(lottery.rule_json);
    const windowDays = rechargeWindowDays(rule);
    const evaluatedAt = new Date();
    if (typeof this.syncService.refreshUser === 'function') {
      user = await this.syncService.refreshUser(userId, {
        rechargeWindowDays: windowDays,
        now: evaluatedAt
      });
    } else {
      user = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    }
    if (!user) throw notFound('用户');

    lottery = this.#row(id);
    const racedEntry = this.db.prepare('SELECT * FROM lottery_entries WHERE lottery_id = ? AND user_id = ?').get(id, userId);
    if (racedEntry) return entryResult(racedEntry, true);
    if (!lottery.published || lottery.status !== 'active') {
      throw conflict('LOTTERY_ENTRY_CLOSED', '抽奖参与已结束，正在处理开奖结果');
    }
    const latestWindow = lotteryWindowStatus(lottery.starts_at, lottery.ends_at, lottery.auto_draw_at);
    if (latestWindow !== 'active') {
      throw conflict('LOTTERY_NOT_ACTIVE', latestWindow === 'upcoming' ? '抽奖活动尚未开始' : '抽奖参与已结束，等待开奖');
    }

    const facts = makeUserFacts(user, getRechargeSummary(this.db, userId, {
      windowDays,
      now: evaluatedAt
    }));
    const evaluation = evaluateRule(rule, facts);
    const systemReasons = participantSystemReasons(user, '抽奖');
    const reasons = [...systemReasons, ...evaluation.reasons];
    if (!evaluation.matched || systemReasons.length > 0) {
      audit(this.db, userId, 'lottery.entry_denied', 'lottery', id, { reasons });
      return { participated: false, eligible: false, facts: factsToApi(facts), reasons };
    }

    const timestamp = nowIso();
    transaction(this.db, () => {
      this.db.prepare(`
        INSERT INTO lottery_entries(
          lottery_id, user_id, facts_json, explanation_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(lottery_id, user_id) DO NOTHING
      `).run(
        id, userId, JSON.stringify(facts),
        JSON.stringify({ ...evaluation, reasons: [] }), timestamp, timestamp
      );
      audit(this.db, userId, 'lottery.entry_created', 'lottery', id);
    });
    const entry = this.db.prepare('SELECT * FROM lottery_entries WHERE lottery_id = ? AND user_id = ?').get(id, userId);
    return entryResult(entry, true);
  }

  async generateSnapshot(idValue, actorUserId) {
    const id = positiveId(idValue);
    const before = this.#row(id);
    if (!['active', 'snapshot_ready'].includes(before.status)) {
      throw conflict('LOTTERY_NOT_DRAWABLE', '只有进行中的抽奖可以生成开奖名单');
    }
    if (this.generating.has(id)) throw conflict('LOTTERY_SNAPSHOT_RUNNING', '候选名单正在生成，请稍后再试');
    this.generating.add(id);
    let closedRegistration = false;
    try {
      if (before.status === 'active') {
        const result = this.db.prepare(`
          UPDATE lotteries SET status = 'snapshot_ready', updated_at = ?
          WHERE id = ? AND status = 'active'
        `).run(nowIso(), id);
        if (Number(result.changes) !== 1) throw conflict('LOTTERY_NOT_EDITABLE', '抽奖状态已变更，未生成候选名单');
        closedRegistration = true;
      }

      const lottery = this.#row(id);
      if (lottery.status !== 'snapshot_ready') {
        throw conflict('LOTTERY_NOT_EDITABLE', '抽奖状态已变更，未更新候选名单');
      }
      const users = this.db.prepare(`
        SELECT u.email, u.username, e.user_id AS entry_user_id,
          e.facts_json AS entry_facts_json, e.explanation_json AS entry_explanation_json
        FROM lottery_entries e
        LEFT JOIN synced_users u ON u.user_id = e.user_id
        WHERE e.lottery_id = ? ORDER BY e.user_id ASC
      `).all(id);
      const generatedAt = nowIso();

      transaction(this.db, () => {
        this.db.prepare('DELETE FROM candidate_snapshots WHERE lottery_id = ?').run(id);
        const insert = this.db.prepare(`
          INSERT INTO candidate_snapshots(
            lottery_id, user_id, email, username, eligible, facts_json, explanation_json, generated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);
        for (const user of users) {
          const userId = Number(user.entry_user_id);
          insert.run(
            id, userId, user.email || '', user.username || '', 1,
            user.entry_facts_json, user.entry_explanation_json, generatedAt
          );
        }
        this.db.prepare(`
          UPDATE lotteries SET status = 'snapshot_ready', candidates_generated_at = ?,
            locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'snapshot_ready'
        `).run(generatedAt, generatedAt, id);
        audit(this.db, actorUserId, 'lottery.snapshot_generated', 'lottery', id, { entries: users.length });
      });
      return this.get(id);
    } catch (error) {
      if (closedRegistration) {
        this.db.prepare(`
          UPDATE lotteries SET status = 'active', updated_at = ?
          WHERE id = ? AND status = 'snapshot_ready' AND candidates_generated_at IS NULL
        `).run(nowIso(), id);
      }
      throw error;
    } finally {
      this.generating.delete(id);
    }
  }

  async lock(idValue, actorUserId) {
    const id = positiveId(idValue);
    if (this.generating.has(id)) throw conflict('LOTTERY_SNAPSHOT_RUNNING', '候选名单正在生成，请稍后再试');
    const lottery = this.#row(id);
    if (lottery.status === 'locked') return this.get(id);
    if (lottery.status !== 'snapshot_ready') throw conflict('SNAPSHOT_REQUIRED', '请先生成候选名单');

    // Locking is the irreversible boundary. Rebuild from successful participation
    // records; eligibility was already checked against live user data on entry.
    await this.generateSnapshot(id, actorUserId);
    const eligible = Number(this.db.prepare('SELECT COUNT(*) AS count FROM candidate_snapshots WHERE lottery_id = ? AND eligible = 1').get(id).count);
    const winners = totalWinnerCount(this.db, id);
    if (winners <= 0) throw conflict('PRIZES_REQUIRED', '至少需要一个奖项');
    if (eligible < winners) throw conflict('NOT_ENOUGH_CANDIDATES', `符合条件的候选人仅 ${eligible} 人，少于计划中奖人数 ${winners}`);
    const lockedAt = nowIso();
    transaction(this.db, () => {
      this.db.prepare('UPDATE candidate_snapshots SET locked_at = ? WHERE lottery_id = ?').run(lockedAt, id);
      this.db.prepare("UPDATE lotteries SET status = 'locked', locked_at = ?, updated_at = ? WHERE id = ?")
        .run(lockedAt, lockedAt, id);
      audit(this.db, actorUserId, 'lottery.locked', 'lottery', id, { eligible, winners });
    });
    return this.get(id);
  }

  draw(idValue, actorUserId, idempotencyKey) {
    const id = positiveId(idValue);
    const key = requiredString(idempotencyKey || `lottery-draw-${id}`, 'Idempotency-Key', 200);
    const replay = this.db.prepare('SELECT id FROM draw_rounds WHERE lottery_id = ? AND idempotency_key = ?').get(id, key);
    if (replay) return this.get(id);
    const lottery = this.#row(id);
    if (lottery.status !== 'locked') throw conflict('LOTTERY_NOT_LOCKED', '只能对已锁定名单的活动开奖');

    transaction(this.db, () => {
      const replayInside = this.db.prepare('SELECT id FROM draw_rounds WHERE lottery_id = ? AND idempotency_key = ?').get(id, key);
      if (replayInside) return;
      const candidates = this.db.prepare(`
        SELECT user_id FROM candidate_snapshots
        WHERE lottery_id = ? AND eligible = 1 AND locked_at IS NOT NULL ORDER BY user_id ASC
      `).all(id).map((row) => Number(row.user_id));
      const prizes = this.db.prepare('SELECT * FROM prizes WHERE lottery_id = ? ORDER BY sort_order ASC, id ASC').all(id);
      const winnerCount = prizes.reduce((sum, prize) => sum + prize.winner_count, 0);
      const selected = randomUnique(candidates, winnerCount);
      const timestamp = nowIso();
      const roundResult = this.db.prepare(`
        INSERT INTO draw_rounds(
          lottery_id, idempotency_key, status, candidate_count, winner_count,
          created_by, created_at, completed_at
        ) VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)
      `).run(id, key, candidates.length, winnerCount, actorUserId, timestamp, timestamp);
      const roundId = Number(roundResult.lastInsertRowid);
      let selectedIndex = 0;
      for (const prize of prizes) {
        for (let i = 0; i < prize.winner_count; i += 1) {
          const userId = selected[selectedIndex++];
          const automated = isAutomatedReward(prize.reward_type);
          const winnerResult = this.db.prepare(`
            INSERT INTO winners(draw_round_id, lottery_id, prize_id, user_id, reward_status, created_at)
            VALUES (?, ?, ?, ?, ?, ?)
          `).run(roundId, id, prize.id, userId, automated ? 'pending' : 'manual', timestamp);
          const winnerId = Number(winnerResult.lastInsertRowid);
          const payload = makeRewardPayload(this.config, winnerId, userId, prize);
          this.db.prepare(`
            INSERT INTO outbox_jobs(
              winner_id, job_type, status, payload_json, attempts, next_attempt_at, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 0, ?, ?, ?)
          `).run(
            winnerId, prize.reward_type, automated ? 'pending' : 'manual', JSON.stringify(payload),
            automated ? timestamp : null, timestamp, timestamp
          );
        }
      }
      this.db.prepare("UPDATE lotteries SET status = 'drawn', drawn_at = ?, auto_draw_error = NULL, updated_at = ? WHERE id = ?")
        .run(timestamp, timestamp, id);
      audit(this.db, actorUserId, 'lottery.drawn', 'lottery', id, { round_id: roundId, winner_count: winnerCount });
    });
    return this.get(id);
  }

  async drawNow(idValue, actorUserId, idempotencyKey) {
    const id = positiveId(idValue);
    let lottery = this.#row(id);
    const startedActive = lottery.status === 'active';
    try {
      if (lottery.status === 'active' || lottery.status === 'snapshot_ready') {
        if (lottery.status === 'active') await this.generateSnapshot(id, actorUserId);
        await this.lock(id, actorUserId);
        lottery = this.#row(id);
      }
      if (lottery.status === 'locked') return this.draw(id, actorUserId, idempotencyKey);
    } catch (error) {
      if (startedActive && this.#row(id).status === 'snapshot_ready') {
        transaction(this.db, () => {
          this.db.prepare('DELETE FROM candidate_snapshots WHERE lottery_id = ?').run(id);
          this.db.prepare(`
            UPDATE lotteries SET status = 'active', candidates_generated_at = NULL,
              locked_at = NULL, updated_at = ? WHERE id = ? AND status = 'snapshot_ready'
          `).run(nowIso(), id);
        });
      }
      throw error;
    }
    const replay = this.db.prepare('SELECT id FROM draw_rounds WHERE lottery_id = ? AND idempotency_key = ?')
      .get(id, idempotencyKey || `lottery-draw-${id}`);
    if (replay) return this.get(id);
    throw conflict('LOTTERY_ALREADY_DRAWN', '当前抽奖已经完成开奖或正在发奖');
  }

  startAutoDraws() {
    if (this.autoDrawTimer) return;
    const interval = Number(this.config.autoDrawIntervalMs) || 10_000;
    this.autoDrawTimer = setInterval(() => {
      this.processDueAutoDraws().catch(() => { /* each failure is persisted on the lottery */ });
    }, interval);
    this.autoDrawTimer.unref?.();
    setImmediate(() => this.processDueAutoDraws().catch(() => {}));
  }

  stopAutoDraws() {
    if (this.autoDrawTimer) clearInterval(this.autoDrawTimer);
    this.autoDrawTimer = null;
  }

  async processDueAutoDraws(limit = 10) {
    if (this.autoDrawing) return { processed: 0, succeeded: 0, failed: 0 };
    this.autoDrawing = true;
    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    try {
      const rows = this.db.prepare(`
        SELECT id, created_by, auto_draw_at FROM lotteries
        WHERE published = 1
          AND auto_draw_at IS NOT NULL
          AND auto_draw_at <= ?
          AND auto_draw_attempted_at IS NULL
          AND status IN ('active', 'snapshot_ready', 'locked')
        ORDER BY auto_draw_at ASC, id ASC LIMIT ?
      `).all(nowIso(), Math.max(1, Math.min(100, Number(limit) || 10)));
      for (const row of rows) {
        const attemptedAt = nowIso();
        const claimed = this.db.prepare(`
          UPDATE lotteries SET auto_draw_attempted_at = ?, auto_draw_error = NULL, updated_at = ?
          WHERE id = ? AND auto_draw_attempted_at IS NULL
            AND status IN ('active', 'snapshot_ready', 'locked')
        `).run(attemptedAt, attemptedAt, row.id);
        if (!claimed.changes) continue;
        processed += 1;
        try {
          await this.drawNow(row.id, row.created_by, `auto-draw-${row.id}-${row.auto_draw_at}`);
          succeeded += 1;
          audit(this.db, null, 'lottery.auto_draw_succeeded', 'lottery', row.id, { scheduled_at: row.auto_draw_at });
        } catch (error) {
          failed += 1;
          const message = String(error?.message || '自动开奖失败').slice(0, 500);
          this.db.prepare('UPDATE lotteries SET auto_draw_error = ?, updated_at = ? WHERE id = ?')
            .run(message, nowIso(), row.id);
          audit(this.db, null, 'lottery.auto_draw_failed', 'lottery', row.id, {
            scheduled_at: row.auto_draw_at,
            code: String(error?.code || 'AUTO_DRAW_FAILED'),
            message
          });
        }
      }
      return { processed, succeeded, failed };
    } finally {
      this.autoDrawing = false;
    }
  }

  #invalidateSnapshot(lotteryId) {
    this.db.prepare('DELETE FROM candidate_snapshots WHERE lottery_id = ?').run(lotteryId);
    this.db.prepare(`
      UPDATE lotteries SET candidates_generated_at = NULL, locked_at = NULL,
        auto_draw_attempted_at = NULL, auto_draw_error = NULL, updated_at = ?
      WHERE id = ?
    `).run(nowIso(), lotteryId);
  }

  #row(id) {
    const row = this.db.prepare('SELECT * FROM lotteries WHERE id = ?').get(id);
    if (!row) throw notFound('抽奖活动');
    return row;
  }

  #toApi(row, detailed) {
    const prizes = this.db.prepare(`
      SELECT p.*, g.name AS group_name FROM prizes p
      LEFT JOIN synced_groups g ON g.group_id = p.group_id
      WHERE p.lottery_id = ? ORDER BY p.sort_order ASC, p.id ASC
    `).all(row.id);
    const counts = this.db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(eligible), 0) AS eligible
      FROM candidate_snapshots WHERE lottery_id = ?
    `).get(row.id);
    const entryCount = Number(this.db.prepare('SELECT COUNT(*) AS count FROM lottery_entries WHERE lottery_id = ?').get(row.id).count);
    const candidates = detailed ? this.db.prepare(`
      SELECT * FROM candidate_snapshots WHERE lottery_id = ? ORDER BY eligible DESC, user_id ASC
    `).all(row.id).map(candidateToApi) : undefined;
    const winners = detailed ? this.db.prepare(`
      SELECT w.*, p.name AS prize_name, o.id AS fulfillment_id,
        o.status AS fulfillment_status, o.last_error,
        p.reward_value, c.email, c.username
      FROM winners w
      JOIN prizes p ON p.id = w.prize_id
      LEFT JOIN outbox_jobs o ON o.winner_id = w.id
      LEFT JOIN candidate_snapshots c ON c.lottery_id = w.lottery_id AND c.user_id = w.user_id
      WHERE w.lottery_id = ? ORDER BY w.id ASC
    `).all(row.id).map(winnerToApi) : undefined;
    const exclusionSummary = detailed ? summarizeExclusions(candidates) : undefined;
    const firstPrize = prizes[0];
    return {
      id: String(row.id),
      name: row.name,
      description: row.description,
      status: row.status,
      published: Boolean(row.published),
      starts_at: row.starts_at || null,
      ends_at: row.ends_at || null,
      auto_draw_at: row.auto_draw_at || null,
      ...(row.auto_draw_attempted_at ? { auto_draw_attempted_at: row.auto_draw_attempted_at } : {}),
      ...(row.auto_draw_error ? { auto_draw_error: row.auto_draw_error } : {}),
      winners_count: prizes.reduce((sum, prize) => sum + prize.winner_count, 0),
      prizes: prizes.map(prizeToApi),
      ...(firstPrize ? { reward: legacyReward(firstPrize) } : {}),
      condition: conditionToApi(parseJson(row.rule_json)),
      entry_count: entryCount,
      candidate_count: Number(counts.eligible || 0),
      excluded_count: Number(counts.total || 0) - Number(counts.eligible || 0),
      ...(row.candidates_generated_at ? { snapshot_at: row.candidates_generated_at } : {}),
      ...(row.locked_at ? { locked_at: row.locked_at } : {}),
      ...(row.drawn_at ? { drawn_at: row.drawn_at } : {}),
      ...(detailed ? { candidates, winners, exclusion_summary: exclusionSummary } : {}),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }
}

function participantSystemReasons(user, activityName) {
  const reasons = [];
  if (user.role !== 'user') reasons.push(`管理员账号不能参与${activityName}`);
  if (user.status !== 'active') reasons.push('账号状态不可用');
  return reasons;
}

function lotteryWindowStatus(startsAt, endsAt, autoDrawAt, now = new Date()) {
  const time = now.getTime();
  if (startsAt && new Date(startsAt).getTime() > time) return 'upcoming';
  if (endsAt && new Date(endsAt).getTime() <= time) return 'ended';
  if (autoDrawAt && new Date(autoDrawAt).getTime() <= time) return 'ended';
  return 'active';
}

function entryResult(entry, participated) {
  const explanation = parseJson(entry.explanation_json, {});
  return {
    participated,
    eligible: participated,
    facts: factsToApi(parseJson(entry.facts_json, {})),
    reasons: explanation.reasons || []
  };
}

function normalizeLotteryInput(input, existing = null) {
  const body = objectBody(input);
  let prizes;
  if (Array.isArray(body.prizes)) {
    if (body.prizes.length === 0 || body.prizes.length > 50) throw conflict('PRIZES_REQUIRED', '奖项数量必须为 1 至 50');
    prizes = body.prizes.map(normalizePrize);
  } else if (body.reward && body.winners_count !== undefined) {
    prizes = [normalizePrize({
      name: body.reward.label,
      winner_count: body.winners_count,
      reward_type: body.reward.type,
      reward_value: body.reward.amount,
      group_id: body.reward.group_id,
      validity_days: body.reward.subscription_days
    })];
  } else {
    throw conflict('PRIZES_REQUIRED', '至少需要一个奖项');
  }
  const startsAt = normalizeOptionalDate(body.starts_at === undefined ? existing?.starts_at : body.starts_at, 'starts_at');
  const endsAt = normalizeOptionalDate(body.ends_at === undefined ? existing?.ends_at : body.ends_at, 'ends_at');
  const autoDrawAt = normalizeOptionalDate(
    body.auto_draw_at === undefined ? existing?.auto_draw_at : body.auto_draw_at,
    'auto_draw_at'
  );
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw conflict('ACTIVITY_WINDOW_INVALID', '活动结束时间必须晚于开始时间');
  }
  if (startsAt && autoDrawAt && startsAt >= autoDrawAt) {
    throw conflict('AUTO_DRAW_TIME_INVALID', '自动开奖时间必须晚于活动开始时间');
  }
  return {
    name: requiredString(body.name, 'name', 120),
    description: optionalString(body.description, 'description', 2000),
    starts_at: startsAt,
    ends_at: endsAt,
    auto_draw_at: autoDrawAt,
    rule: conditionFromApi(body.condition),
    prizes
  };
}

function normalizeOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw conflict('ACTIVITY_WINDOW_INVALID', `${field}必须是日期字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw conflict('ACTIVITY_WINDOW_INVALID', `${field}不是有效日期`);
  return date.toISOString();
}

function normalizePrize(input) {
  const body = objectBody(input);
  const rewardType = String(body.reward_type || body.type || '');
  if (!REWARD_TYPES.has(rewardType)) {
    throw conflict('REWARD_TYPE_INVALID', '奖品类型只能是 physical、manual、balance、concurrency 或 subscription');
  }
  const winnerCount = integer(body.winner_count ?? body.winners_count, 'winner_count', { min: 1, max: 10_000 });
  let rewardValue;
  if (rewardType === 'concurrency') {
    rewardValue = String(integer(Number(body.reward_value ?? body.amount), 'reward_value', { min: 1, max: 1_000_000 }));
  } else if (rewardType === 'manual' || rewardType === 'physical') {
    rewardValue = assertDecimalString(body.reward_value ?? body.amount ?? 0, 'reward_value');
  } else {
    rewardValue = assertDecimalString(body.reward_value ?? body.amount, 'reward_value', { min: '0.000001' });
  }
  const groupId = rewardType === 'subscription' ? positiveId(body.group_id, 'group_id') : null;
  const validityDays = rewardType === 'subscription'
    ? integer(body.validity_days ?? body.subscription_days, 'validity_days', { min: 1, max: 36500 })
    : null;
  return {
    name: requiredString(body.name || body.label, 'name', 120),
    winner_count: winnerCount,
    reward_type: rewardType,
    reward_value: rewardValue,
    group_id: groupId,
    validity_days: validityDays,
    sort_order: body.sort_order === undefined ? undefined : integer(body.sort_order, 'sort_order', { min: -1_000_000, max: 1_000_000 })
  };
}

function isAutomatedReward(rewardType) {
  return !['manual', 'physical'].includes(rewardType);
}

function insertPrize(db, lotteryId, prize, index, timestamp) {
  const result = db.prepare(`
    INSERT INTO prizes(
      lottery_id, name, winner_count, reward_type, reward_value,
      group_id, validity_days, sort_order, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lotteryId, prize.name, prize.winner_count, prize.reward_type, prize.reward_value,
    prize.group_id, prize.validity_days, prize.sort_order ?? index, timestamp, timestamp
  );
  return Number(result.lastInsertRowid);
}

function totalWinnerCount(db, lotteryId) {
  return Number(db.prepare('SELECT COALESCE(SUM(winner_count), 0) AS count FROM prizes WHERE lottery_id = ?').get(lotteryId).count);
}

function prizeToApi(row) {
  return {
    id: String(row.id),
    name: row.name,
    winner_count: row.winner_count,
    reward_type: row.reward_type,
    reward_value: Number(row.reward_value),
    ...(row.group_id ? { group_id: row.group_id } : {}),
    ...(row.group_name ? { group_name: row.group_name } : {}),
    ...(row.validity_days ? { validity_days: row.validity_days } : {}),
    sort_order: row.sort_order
  };
}

function legacyReward(prize) {
  return {
    type: prize.reward_type,
    amount: Number(prize.reward_value),
    label: prize.name,
    ...(prize.group_id ? { group_id: prize.group_id } : {}),
    ...(prize.validity_days ? { subscription_days: prize.validity_days } : {})
  };
}

function candidateToApi(row) {
  const facts = parseJson(row.facts_json, {});
  const result = parseJson(row.explanation_json, {});
  return {
    id: String(row.id),
    user_id: row.user_id,
    email: row.email,
    username: row.username,
    eligible: Boolean(row.eligible),
    facts: factsToApi(facts),
    exclusion_reasons: result.reasons || [],
    snapshot_at: row.generated_at
  };
}

function winnerToApi(row) {
  return {
    id: String(row.id),
    user_id: row.user_id,
    email: row.email || '',
    username: row.username || '',
    prize_name: row.prize_name,
    reward_value: Number(row.reward_value),
    fulfillment_status: row.fulfillment_status || row.reward_status,
    ...(row.fulfillment_id ? { fulfillment_id: String(row.fulfillment_id) } : {}),
    ...(row.last_error ? { fulfillment_error: row.last_error } : {}),
    drawn_at: row.created_at
  };
}

function summarizeExclusions(candidates) {
  const counts = new Map();
  for (const candidate of candidates || []) {
    for (const reason of candidate.exclusion_reasons || []) counts.set(reason, (counts.get(reason) || 0) + 1);
  }
  return [...counts.entries()].map(([label, count], index) => ({ code: `reason_${index + 1}`, label, count }));
}

function makeRewardPayload(config, winnerId, userId, prize) {
  const digest = createHash('sha256').update(`winner:${winnerId}`).digest('hex').slice(0, 24).toUpperCase();
  const code = `${config.rewardCodePrefix}${digest}`;
  return {
    user_id: userId,
    code,
    idempotency_key: `sub2api-extension-reward-${winnerId}`,
    type: prize.reward_type,
    value: prize.reward_value,
    group_id: prize.group_id,
    validity_days: prize.validity_days,
    notes: `[sub2api-extension reward:${winnerId}] ${prize.name}`
  };
}
