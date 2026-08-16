import { createHash } from 'node:crypto';
import { audit, nowIso, parseJson, transaction } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import { assertDecimalString } from './money.js';
import {
  conditionFromApi,
  conditionToApi,
  evaluateRule,
  factsToApi,
  makeUserFacts,
  rechargeWindowDays
} from './rules.js';
import { getRechargeSummary } from './sync.js';
import { boolean, objectBody, optionalString, positiveId, requiredString } from './validation.js';

const ACTIVITY_TYPES = new Set(['lottery', 'checkin', 'group_entitlement']);

export class ActivityService {
  constructor(db, client, syncService, lotteries, groupEntitlements, config) {
    this.db = db;
    this.client = client;
    this.syncService = syncService;
    this.lotteries = lotteries;
    this.groupEntitlements = groupEntitlements;
    this.config = config;
  }

  async listForUser(userIdValue) {
    const userId = positiveId(userIdValue, 'user_id');
    const items = [];
    for (const row of this.db.prepare('SELECT * FROM lotteries WHERE published = 1 ORDER BY id DESC').all()) {
      items.push(lotterySummary(row, userId, this.db));
    }
    for (const row of this.db.prepare('SELECT * FROM checkin_campaigns WHERE published = 1 ORDER BY id DESC').all()) {
      items.push(this.#checkinSummary(row, userId));
    }
    const rules = this.db.prepare(`
      SELECT r.*, g.name AS group_name FROM group_entitlement_rules r
      LEFT JOIN synced_groups g ON g.group_id = r.group_id
      WHERE r.enabled = 1 AND r.assignment_mode = 'claim'
        AND (r.activity_ends_at IS NULL OR r.activity_ends_at > ?)
      ORDER BY r.id DESC
    `).all(nowIso());
    for (const row of rules) {
      const state = await this.groupEntitlements.claimState(row.id, userId);
      items.push(groupSummary(row, state));
    }
    items.sort(compareActivities);
    return { items, total: items.length };
  }

  async getForUser(typeValue, idValue, userIdValue) {
    const type = normalizeActivityType(typeValue);
    const id = positiveId(idValue);
    const userId = positiveId(userIdValue, 'user_id');
    if (type === 'lottery') return this.#lotteryDetail(id, userId);
    if (type === 'checkin') return this.#checkinDetail(id, userId, true);
    const rule = this.db.prepare(`
      SELECT r.*, g.name AS group_name FROM group_entitlement_rules r
      LEFT JOIN synced_groups g ON g.group_id = r.group_id
      WHERE r.id = ? AND r.enabled = 1 AND r.assignment_mode = 'claim'
        AND (r.activity_ends_at IS NULL OR r.activity_ends_at > ?)
    `).get(id, nowIso());
    if (!rule) throw notFound('资格活动');
    return groupSummary(rule, await this.groupEntitlements.claimState(id, userId, { refresh: true }), true);
  }

  async participate(typeValue, idValue, userIdValue) {
    const type = normalizeActivityType(typeValue);
    if (type === 'group_entitlement') {
      return this.groupEntitlements.claim(idValue, userIdValue);
    }
    if (type === 'checkin') return this.checkin(idValue, userIdValue);
    const result = await this.lotteries.participate(idValue, userIdValue);
    return { ...this.#lotteryDetail(positiveId(idValue), positiveId(userIdValue, 'user_id')), ...result };
  }

  listCheckins() {
    const rows = this.db.prepare('SELECT * FROM checkin_campaigns ORDER BY id DESC').all();
    return { items: rows.map((row) => checkinToAdminApi(row, this.db)), total: rows.length };
  }

  getCheckin(idValue) {
    const id = positiveId(idValue);
    const row = this.db.prepare('SELECT * FROM checkin_campaigns WHERE id = ?').get(id);
    if (!row) throw notFound('签到活动');
    return checkinToAdminApi(row, this.db);
  }

  createCheckin(input, actorUserId) {
    const value = normalizeCheckinInput(input);
    const timestamp = nowIso();
    const id = transaction(this.db, () => {
      const result = this.db.prepare(`
        INSERT INTO checkin_campaigns(
          name, description, published, condition_json, reward_type, reward_value,
          starts_at, ends_at, created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.name, value.description, value.published ? 1 : 0, JSON.stringify(value.condition),
        value.reward_type, value.reward_value, value.starts_at, value.ends_at,
        actorUserId, timestamp, timestamp
      );
      const campaignId = Number(result.lastInsertRowid);
      audit(this.db, actorUserId, 'checkin.created', 'checkin_campaign', campaignId, {
        published: value.published,
        reward_type: value.reward_type
      });
      return campaignId;
    });
    return this.getCheckin(id);
  }

  updateCheckin(idValue, input, actorUserId) {
    const id = positiveId(idValue);
    const existing = this.db.prepare('SELECT * FROM checkin_campaigns WHERE id = ?').get(id);
    if (!existing) throw notFound('签到活动');
    const value = normalizeCheckinInput(input, existing);
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE checkin_campaigns SET name = ?, description = ?, published = ?,
          condition_json = ?, reward_type = ?, reward_value = ?, starts_at = ?,
          ends_at = ?, updated_at = ? WHERE id = ?
      `).run(
        value.name, value.description, value.published ? 1 : 0, JSON.stringify(value.condition),
        value.reward_type, value.reward_value, value.starts_at, value.ends_at, nowIso(), id
      );
      audit(this.db, actorUserId, 'checkin.updated', 'checkin_campaign', id, {
        published: value.published,
        reward_type: value.reward_type
      });
    });
    return this.getCheckin(id);
  }

  deleteCheckin(idValue, actorUserId) {
    const id = positiveId(idValue);
    const existing = this.db.prepare('SELECT * FROM checkin_campaigns WHERE id = ?').get(id);
    if (!existing) throw notFound('签到活动');
    const records = Number(this.db.prepare('SELECT COUNT(*) AS count FROM checkin_records WHERE campaign_id = ?').get(id).count);
    if (records > 0) throw conflict('CHECKIN_HAS_RECORDS', '已有用户签到记录，只能停用活动，不能删除');
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM checkin_campaigns WHERE id = ?').run(id);
      audit(this.db, actorUserId, 'checkin.deleted', 'checkin_campaign', id);
    });
  }

  async checkin(idValue, userIdValue) {
    const id = positiveId(idValue);
    const userId = positiveId(userIdValue, 'user_id');
    const campaign = this.db.prepare('SELECT * FROM checkin_campaigns WHERE id = ? AND published = 1').get(id);
    if (!campaign) throw notFound('签到活动');
    const status = windowStatus(campaign.starts_at, campaign.ends_at);
    if (status !== 'active') {
      throw conflict('CHECKIN_NOT_ACTIVE', status === 'upcoming' ? '签到活动尚未开始' : '签到活动已结束');
    }

    const today = localDate(this.config.activityTimeZone);
    const existing = this.db.prepare(`
      SELECT * FROM checkin_records WHERE campaign_id = ? AND user_id = ? AND local_date = ?
    `).get(id, userId, today);
    if (existing) {
      if (campaign.reward_type === 'balance' && existing.reward_status === 'failed') {
        await this.#issueCheckinReward(campaign, existing.id, userId);
      }
      return this.#checkinDetail(id, userId, false);
    }

    const condition = parseJson(campaign.condition_json);
    const windowDays = rechargeWindowDays(condition);
    const evaluatedAt = new Date();
    const user = await this.syncService.refreshUser(userId, {
      rechargeWindowDays: windowDays,
      now: evaluatedAt
    });
    const facts = makeUserFacts(user, getRechargeSummary(this.db, userId, {
      windowDays,
      now: evaluatedAt
    }));
    const evaluation = evaluateRule(condition, facts);
    const eligible = user.role === 'user' && user.status === 'active' && evaluation.matched;
    const reasons = [];
    if (user.role !== 'user') reasons.push('管理员账号不能参与签到');
    if (user.status !== 'active') reasons.push('账号状态不可用');
    reasons.push(...evaluation.reasons);
    if (!eligible) {
      return {
        ...(await this.#checkinDetail(id, userId, false)),
        eligible: false,
        reasons
      };
    }

    const streakDays = this.#nextStreak(id, userId, today);
    const timestamp = nowIso();
    const rewardStatus = campaign.reward_type === 'balance' ? 'pending' : 'none';
    const recordId = transaction(this.db, () => {
      const result = this.db.prepare(`
        INSERT INTO checkin_records(
          campaign_id, user_id, local_date, streak_days, facts_json,
          reward_status, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(campaign_id, user_id, local_date) DO NOTHING
      `).run(id, userId, today, streakDays, JSON.stringify(facts), rewardStatus, timestamp, timestamp);
      if (!result.changes) return null;
      const createdId = Number(result.lastInsertRowid);
      audit(this.db, userId, 'checkin.completed', 'checkin_campaign', id, {
        record_id: createdId,
        local_date: today,
        streak_days: streakDays
      });
      return createdId;
    });

    if (!recordId) return this.#checkinDetail(id, userId, false);
    if (campaign.reward_type === 'balance') await this.#issueCheckinReward(campaign, recordId, userId);
    return this.#checkinDetail(id, userId, false);
  }

  #lotteryDetail(id, userId) {
    const row = this.db.prepare('SELECT * FROM lotteries WHERE id = ? AND published = 1').get(id);
    if (!row) throw notFound('抽奖活动');
    const summary = lotterySummary(row, userId, this.db);
    const prizes = this.db.prepare(`
      SELECT p.id, p.name, p.winner_count, p.reward_type, p.reward_value,
        p.group_id, p.validity_days, p.sort_order, g.name AS group_name
      FROM prizes p LEFT JOIN synced_groups g ON g.group_id = p.group_id
      WHERE p.lottery_id = ? ORDER BY p.sort_order, p.id
    `).all(id).map((prize) => ({
      id: String(prize.id),
      name: prize.name,
      winner_count: Number(prize.winner_count),
      reward_type: prize.reward_type,
      reward_value: Number(prize.reward_value),
      ...(prize.group_id ? { group_id: Number(prize.group_id) } : {}),
      ...(prize.group_name ? { group_name: prize.group_name } : {}),
      ...(prize.validity_days ? { validity_days: Number(prize.validity_days) } : {}),
      sort_order: Number(prize.sort_order)
    }));
    const candidate = this.db.prepare(`
      SELECT eligible, facts_json, explanation_json, generated_at FROM candidate_snapshots
      WHERE lottery_id = ? AND user_id = ?
    `).get(id, userId);
    const entry = this.db.prepare(`
      SELECT facts_json, explanation_json, created_at FROM lottery_entries
      WHERE lottery_id = ? AND user_id = ?
    `).get(id, userId);
    const winner = this.db.prepare(`
      SELECT p.name AS prize_name, p.reward_type, p.reward_value, w.reward_status, w.created_at
      FROM winners w JOIN prizes p ON p.id = w.prize_id
      WHERE w.lottery_id = ? AND w.user_id = ? ORDER BY w.id LIMIT 1
    `).get(id, userId);
    return {
      ...summary,
      condition: conditionToApi(parseJson(row.rule_json)),
      prizes,
      eligibility_confirmed: Boolean(candidate),
      eligible: candidate ? Boolean(candidate.eligible) : null,
      participated: Boolean(entry),
      facts: candidate
        ? factsToApi(parseJson(candidate.facts_json, {}))
        : entry ? factsToApi(parseJson(entry.facts_json, {})) : undefined,
      reasons: candidate
        ? parseJson(candidate.explanation_json, {}).reasons || []
        : entry ? parseJson(entry.explanation_json, {}).reasons || [] : [],
      winner: winner ? {
        prize_name: winner.prize_name,
        reward_type: winner.reward_type,
        reward_value: Number(winner.reward_value),
        reward_status: winner.reward_status,
        drawn_at: winner.created_at
      } : null
    };
  }

  async #checkinDetail(id, userId, refreshUser) {
    const row = this.db.prepare('SELECT * FROM checkin_campaigns WHERE id = ? AND published = 1').get(id);
    if (!row) throw notFound('签到活动');
    const condition = parseJson(row.condition_json);
    const windowDays = rechargeWindowDays(condition);
    const evaluatedAt = new Date();
    if (refreshUser) {
      await this.syncService.refreshUser(userId, {
        rechargeWindowDays: windowDays,
        now: evaluatedAt
      });
    }
    const user = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    if (!user) throw notFound('用户');
    const facts = makeUserFacts(user, getRechargeSummary(this.db, userId, {
      windowDays,
      now: evaluatedAt
    }));
    const evaluation = evaluateRule(condition, facts);
    const reasons = [];
    if (user.role !== 'user') reasons.push('管理员账号不能参与签到');
    if (user.status !== 'active') reasons.push('账号状态不可用');
    reasons.push(...evaluation.reasons);
    const summary = this.#checkinSummary(row, userId);
    const today = localDate(this.config.activityTimeZone);
    const month = today.slice(0, 7);
    const checkedDates = this.db.prepare(`
      SELECT local_date FROM checkin_records
      WHERE campaign_id = ? AND user_id = ? AND local_date >= ? AND local_date < ?
      ORDER BY local_date ASC
    `).all(row.id, userId, `${month}-01`, nextMonthStart(month)).map((record) => record.local_date);
    return {
      ...summary,
      participation: {
        ...summary.participation,
        today,
        current_month: month,
        checked_dates: checkedDates
      },
      condition: conditionToApi(parseJson(row.condition_json)),
      facts: factsToApi(facts),
      eligible: user.role === 'user' && user.status === 'active' && evaluation.matched,
      reasons
    };
  }

  #checkinSummary(row, userId) {
    const today = localDate(this.config.activityTimeZone);
    const todayRecord = this.db.prepare(`
      SELECT * FROM checkin_records WHERE campaign_id = ? AND user_id = ? AND local_date = ?
    `).get(row.id, userId, today);
    const totalDays = Number(this.db.prepare(`
      SELECT COUNT(*) AS count FROM checkin_records WHERE campaign_id = ? AND user_id = ?
    `).get(row.id, userId).count);
    const latest = todayRecord || this.db.prepare(`
      SELECT * FROM checkin_records WHERE campaign_id = ? AND user_id = ? ORDER BY local_date DESC LIMIT 1
    `).get(row.id, userId);
    return {
      id: String(row.id),
      type: 'checkin',
      name: row.name,
      description: row.description,
      status: windowStatus(row.starts_at, row.ends_at),
      starts_at: row.starts_at || null,
      ends_at: row.ends_at || null,
      action_label: todayRecord ? '今日已签到' : '立即签到',
      reward: {
        type: row.reward_type,
        value: Number(row.reward_value)
      },
      participation: {
        checked_today: Boolean(todayRecord),
        total_days: totalDays,
        streak_days: latest ? Number(latest.streak_days) : 0,
        reward_status: todayRecord?.reward_status || 'none'
      },
      updated_at: row.updated_at
    };
  }

  #nextStreak(campaignId, userId, today) {
    const yesterday = shiftDate(today, -1);
    const previous = this.db.prepare(`
      SELECT streak_days FROM checkin_records
      WHERE campaign_id = ? AND user_id = ? AND local_date = ?
    `).get(campaignId, userId, yesterday);
    return previous ? Number(previous.streak_days) + 1 : 1;
  }

  async #issueCheckinReward(campaign, recordId, userId) {
    const digest = createHash('sha256').update(`checkin:${recordId}`).digest('hex').slice(0, 24).toUpperCase();
    const code = `${this.config.rewardCodePrefix}${digest}`;
    const idempotencyKey = `sub2api-extension-checkin-${recordId}`;
    try {
      const result = await this.client.createAndRedeem({
        user_id: userId,
        code,
        type: 'balance',
        value: campaign.reward_value,
        notes: `[sub2api-extension reward:checkin-${recordId}] ${campaign.name}`
      }, idempotencyKey);
      const externalRef = String(result?.redeem_code?.id || result?.id || '');
      this.db.prepare(`
        UPDATE checkin_records SET reward_status = 'succeeded', reward_external_ref = ?,
          reward_error = NULL, updated_at = ? WHERE id = ?
      `).run(externalRef, nowIso(), recordId);
    } catch (error) {
      this.db.prepare(`
        UPDATE checkin_records SET reward_status = 'failed', reward_error = ?, updated_at = ? WHERE id = ?
      `).run(String(error?.code || 'REWARD_FAILED').slice(0, 120), nowIso(), recordId);
    }
  }
}

function normalizeActivityType(value) {
  const type = String(value || '');
  if (!ACTIVITY_TYPES.has(type)) throw badRequest('ACTIVITY_TYPE_INVALID', '不支持的活动类型');
  return type;
}

function normalizeCheckinInput(input, existing = null) {
  const body = objectBody(input);
  const rewardType = String(body.reward_type ?? existing?.reward_type ?? 'none');
  if (!['none', 'balance'].includes(rewardType)) {
    throw badRequest('CHECKIN_REWARD_INVALID', '签到奖励类型只能是 none 或 balance');
  }
  const startsAt = normalizeOptionalDate(body.starts_at === undefined ? existing?.starts_at : body.starts_at, 'starts_at');
  const endsAt = normalizeOptionalDate(body.ends_at === undefined ? existing?.ends_at : body.ends_at, 'ends_at');
  if (startsAt && endsAt && startsAt >= endsAt) {
    throw badRequest('ACTIVITY_WINDOW_INVALID', '活动结束时间必须晚于开始时间');
  }
  return {
    name: requiredString(body.name ?? existing?.name, 'name', 120),
    description: optionalString(body.description === undefined ? existing?.description : body.description, 'description', 1000),
    published: boolean(body.published ?? Boolean(existing?.published), 'published'),
    condition: conditionFromApi(body.condition ?? conditionToApi(parseJson(existing?.condition_json))),
    reward_type: rewardType,
    reward_value: rewardType === 'balance'
      ? assertDecimalString(body.reward_value ?? existing?.reward_value, 'reward_value', { min: '0.000001' })
      : '0',
    starts_at: startsAt,
    ends_at: endsAt
  };
}

function normalizeOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('ACTIVITY_WINDOW_INVALID', `${field}必须是日期字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest('ACTIVITY_WINDOW_INVALID', `${field}不是有效日期`);
  return date.toISOString();
}

function windowStatus(startsAt, endsAt, now = new Date()) {
  const time = now.getTime();
  if (startsAt && new Date(startsAt).getTime() > time) return 'upcoming';
  if (endsAt && new Date(endsAt).getTime() <= time) return 'ended';
  return 'active';
}

function lotterySummary(row, userId, db) {
  const candidate = db.prepare(`
    SELECT eligible FROM candidate_snapshots WHERE lottery_id = ? AND user_id = ?
  `).get(row.id, userId);
  const winner = db.prepare('SELECT id FROM winners WHERE lottery_id = ? AND user_id = ?').get(row.id, userId);
  const entry = db.prepare('SELECT id FROM lottery_entries WHERE lottery_id = ? AND user_id = ?').get(row.id, userId);
  return {
    id: String(row.id),
    type: 'lottery',
    name: row.name,
    description: row.description,
    status: windowStatus(row.starts_at, earliestDate(row.ends_at, row.auto_draw_at)),
    phase: row.status,
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    auto_draw_at: row.auto_draw_at || null,
    drawn_at: row.drawn_at || null,
    action_label: row.drawn_at ? '查看结果' : entry ? '已参与' : '参与抽奖',
    participation: {
      participated: Boolean(entry),
      eligibility_confirmed: Boolean(candidate),
      eligible: candidate ? Boolean(candidate.eligible) : null,
      won: Boolean(winner)
    },
    updated_at: row.updated_at
  };
}

function earliestDate(...values) {
  const dates = values.filter(Boolean).sort();
  return dates[0] || null;
}

function groupSummary(row, state, detailed = false) {
  return {
    id: String(row.id),
    type: 'group_entitlement',
    name: row.name,
    description: row.activity_description || `满足条件后可领取 ${row.group_name || '专属分组'} 资格`,
    status: windowStatus(row.activity_starts_at, row.activity_ends_at),
    starts_at: row.activity_starts_at || null,
    ends_at: row.activity_ends_at || null,
    action_label: state.granted ? '已获得资格' : '立即领取',
    group_id: Number(row.group_id),
    group_name: row.group_name || '',
    participation: {
      eligible: state.eligible,
      granted: state.granted,
      reasons: state.reasons
    },
    ...(detailed ? {
      condition: state.condition,
      facts: state.facts,
      eligible: state.eligible,
      granted: state.granted,
      already_granted: state.already_granted,
      reasons: state.reasons
    } : {}),
    updated_at: row.updated_at
  };
}

function checkinToAdminApi(row, db) {
  const stats = db.prepare(`
    SELECT COUNT(*) AS records, COUNT(DISTINCT user_id) AS users
    FROM checkin_records WHERE campaign_id = ?
  `).get(row.id);
  return {
    id: String(row.id),
    name: row.name,
    description: row.description,
    published: Boolean(row.published),
    condition: conditionToApi(parseJson(row.condition_json)),
    reward_type: row.reward_type,
    reward_value: Number(row.reward_value),
    starts_at: row.starts_at || null,
    ends_at: row.ends_at || null,
    record_count: Number(stats.records || 0),
    participant_count: Number(stats.users || 0),
    created_at: row.created_at,
    updated_at: row.updated_at
  };
}

function compareActivities(left, right) {
  const order = { active: 0, upcoming: 1, ended: 2 };
  const statusDifference = order[left.status] - order[right.status];
  if (statusDifference !== 0) return statusDifference;
  return new Date(right.updated_at || 0).getTime() - new Date(left.updated_at || 0).getTime();
}

function localDate(timeZone, now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

function shiftDate(value, days) {
  const date = new Date(`${value}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function nextMonthStart(month) {
  const [year, monthNumber] = month.split('-').map(Number);
  return new Date(Date.UTC(year, monthNumber, 1)).toISOString().slice(0, 10);
}
