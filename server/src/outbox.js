import { audit, nowIso, parseJson, transaction } from './db.js';
import { conflict, notFound } from './errors.js';
import { positiveId } from './validation.js';

const MAX_ATTEMPTS = 10;

export class OutboxService {
  constructor(db, client, config) {
    this.db = db;
    this.client = client;
    this.config = config;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    transaction(this.db, () => {
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE outbox_jobs SET status = 'failed', next_attempt_at = ?,
          last_error = COALESCE(last_error, '服务重启后恢复未完成任务'), updated_at = ?
        WHERE status = 'processing'
      `).run(timestamp, timestamp);
      this.db.prepare(`
        UPDATE winners SET reward_status = 'failed'
        WHERE id IN (SELECT winner_id FROM outbox_jobs WHERE status = 'failed')
          AND reward_status = 'processing'
      `).run();
    });
    this.timer = setInterval(() => {
      this.processDue().catch(() => { /* failure is persisted on each job */ });
    }, this.config.outboxIntervalMs);
    this.timer.unref?.();
    setImmediate(() => this.processDue().catch(() => {}));
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async processDue(limit = 20) {
    if (this.running) return { processed: 0 };
    this.running = true;
    let processed = 0;
    try {
      const rows = this.db.prepare(`
        SELECT id FROM outbox_jobs
        WHERE job_type NOT IN ('manual', 'physical')
          AND status IN ('pending', 'failed')
          AND attempts < ?
          AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
        ORDER BY id ASC LIMIT ?
      `).all(MAX_ATTEMPTS, nowIso(), limit);
      for (const row of rows) {
        if (await this.#processOne(row.id)) processed += 1;
      }
      return { processed };
    } finally {
      this.running = false;
    }
  }

  async processLottery(lotteryIdValue) {
    const lotteryId = positiveId(lotteryIdValue);
    const rows = this.db.prepare(`
      SELECT o.id FROM outbox_jobs o
      JOIN winners w ON w.id = o.winner_id
      WHERE w.lottery_id = ? AND o.job_type NOT IN ('manual', 'physical') AND o.status != 'succeeded'
      ORDER BY o.id ASC
    `).all(lotteryId);
    for (const row of rows) await this.#processOne(row.id, true);
    this.#refreshLotteryStatus(lotteryId);
    return { processed: rows.length };
  }

  retry(idValue, actorUserId) {
    const id = positiveId(idValue);
    const row = this.#job(id);
    if (isManualReward(row.job_type)) throw conflict('MANUAL_REWARD', '人工奖品不能通过自动发奖重试');
    if (row.status === 'succeeded') return rowToApi(row);
    if (row.status === 'pending') return rowToApi(row);
    if (row.status === 'processing') throw conflict('REWARD_PROCESSING', '发奖任务正在处理，请稍后再试');
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE outbox_jobs SET status = 'pending', attempts = 0, next_attempt_at = ?,
          last_error = NULL, updated_at = ? WHERE id = ?
      `).run(nowIso(), nowIso(), id);
      audit(this.db, actorUserId, 'reward.retry_requested', 'outbox_job', id);
    });
    setImmediate(() => this.processDue().catch(() => {}));
    return rowToApi(this.#job(id));
  }

  completeManual(idValue, actorUserId, externalRef = '') {
    const id = positiveId(idValue);
    const row = this.#job(id);
    if (!isManualReward(row.job_type)) throw conflict('NOT_MANUAL_REWARD', '该奖品不是人工发放类型');
    transaction(this.db, () => {
      const timestamp = nowIso();
      this.db.prepare(`
        UPDATE outbox_jobs SET status = 'succeeded', external_ref = ?, last_error = NULL, updated_at = ? WHERE id = ?
      `).run(String(externalRef || '').slice(0, 200), timestamp, id);
      this.db.prepare("UPDATE winners SET reward_status = 'succeeded' WHERE id = ?").run(row.winner_id);
      audit(this.db, actorUserId, 'manual_reward.completed', 'outbox_job', id);
    });
    this.#refreshLotteryStatus(row.lottery_id);
    return rowToApi(this.#job(id));
  }

  listForLottery(lotteryIdValue) {
    const lotteryId = positiveId(lotteryIdValue);
    const rows = this.db.prepare(`
      SELECT o.*, w.lottery_id, w.user_id FROM outbox_jobs o
      JOIN winners w ON w.id = o.winner_id WHERE w.lottery_id = ? ORDER BY o.id ASC
    `).all(lotteryId);
    return { items: rows.map(rowToApi), total: rows.length };
  }

  async #processOne(id, ignoreSchedule = false) {
    const claimed = transaction(this.db, () => {
      const row = this.#job(id);
      if (isManualReward(row.job_type) || row.status === 'succeeded' || row.status === 'processing') return null;
      if (!ignoreSchedule && row.next_attempt_at && row.next_attempt_at > nowIso()) return null;
      if (row.attempts >= MAX_ATTEMPTS && !ignoreSchedule) return null;
      const result = this.db.prepare(`
        UPDATE outbox_jobs SET status = 'processing', attempts = attempts + 1, updated_at = ?
        WHERE id = ? AND status IN ('pending', 'failed')
      `).run(nowIso(), id);
      if (!result.changes) return null;
      this.db.prepare("UPDATE winners SET reward_status = 'processing' WHERE id = ?").run(row.winner_id);
      return this.#job(id);
    });
    if (!claimed) return false;
    const payload = parseJson(claimed.payload_json, {});
    const request = {
      code: payload.code,
      type: payload.type,
      value: Number(payload.value),
      user_id: payload.user_id,
      notes: payload.notes
    };
    if (payload.type === 'subscription') {
      request.group_id = payload.group_id;
      request.validity_days = payload.validity_days;
    }
    try {
      const data = await this.client.createAndRedeem(request, payload.idempotency_key);
      const externalRef = String(data?.redeem_code?.id || data?.redeem_code?.code || payload.code || '').slice(0, 200);
      transaction(this.db, () => {
        this.db.prepare(`
          UPDATE outbox_jobs SET status = 'succeeded', next_attempt_at = NULL, last_error = NULL,
            external_ref = ?, updated_at = ? WHERE id = ?
        `).run(externalRef, nowIso(), id);
        this.db.prepare("UPDATE winners SET reward_status = 'succeeded' WHERE id = ?").run(claimed.winner_id);
        audit(this.db, null, 'reward.succeeded', 'outbox_job', id, { winner_id: claimed.winner_id });
      });
    } catch (error) {
      const latest = this.#job(id);
      const delaySeconds = Math.min(3600, 5 * 2 ** Math.min(latest.attempts, 10));
      const retryAt = new Date(Date.now() + delaySeconds * 1000).toISOString();
      const safeError = `${String(error?.code || 'REWARD_FAILED')}: ${String(error?.message || '发奖失败')}`.slice(0, 500);
      transaction(this.db, () => {
        this.db.prepare(`
          UPDATE outbox_jobs SET status = 'failed', next_attempt_at = ?, last_error = ?, updated_at = ? WHERE id = ?
        `).run(retryAt, safeError, nowIso(), id);
        this.db.prepare("UPDATE winners SET reward_status = 'failed' WHERE id = ?").run(claimed.winner_id);
        audit(this.db, null, 'reward.failed', 'outbox_job', id, { winner_id: claimed.winner_id, retry_at: retryAt });
      });
    }
    this.#refreshLotteryStatus(claimed.lottery_id);
    return true;
  }

  #job(id) {
    const row = this.db.prepare(`
      SELECT o.*, w.lottery_id, w.user_id FROM outbox_jobs o
      JOIN winners w ON w.id = o.winner_id WHERE o.id = ?
    `).get(id);
    if (!row) throw notFound('发奖任务');
    return row;
  }

  #refreshLotteryStatus(lotteryId) {
    const counts = this.db.prepare(`
      SELECT
        SUM(CASE WHEN o.status = 'succeeded' THEN 1 ELSE 0 END) AS succeeded,
        SUM(CASE WHEN o.status = 'failed' THEN 1 ELSE 0 END) AS failed,
        SUM(CASE WHEN o.status IN ('pending', 'processing') THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN o.status = 'manual' THEN 1 ELSE 0 END) AS manual,
        COUNT(*) AS total
      FROM outbox_jobs o JOIN winners w ON w.id = o.winner_id WHERE w.lottery_id = ?
    `).get(lotteryId);
    if (!counts?.total) return;
    let status = 'drawn';
    if (Number(counts.active) > 0) status = 'fulfilling';
    else if (Number(counts.failed) > 0) status = 'failed';
    else if (Number(counts.manual) === 0 && Number(counts.succeeded) === Number(counts.total)) status = 'fulfilled';
    this.db.prepare('UPDATE lotteries SET status = ?, updated_at = ? WHERE id = ?').run(status, nowIso(), lotteryId);
  }
}

function isManualReward(type) {
  return type === 'manual' || type === 'physical';
}

function rowToApi(row) {
  return {
    id: String(row.id),
    winner_id: String(row.winner_id),
    user_id: row.user_id,
    lottery_id: String(row.lottery_id),
    type: row.job_type,
    status: row.status,
    attempts: row.attempts,
    ...(row.last_error ? { error: row.last_error } : {}),
    ...(row.external_ref ? { external_ref: row.external_ref } : {}),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}
