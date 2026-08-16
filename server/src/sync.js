import { centsFromUpstream, addIntegerStrings } from './money.js';
import { nowIso, parseJson, transaction } from './db.js';

const PAGE_SIZE = 1000;
const RECHARGE_TYPES = ['balance', 'admin_balance'];
const EXTENSION_NOTES_MARKER = 'sub2api-extension reward:';

export function shouldIncludeRecharge(code, rewardCodePrefix) {
  if (!code || code.status !== 'used' || !RECHARGE_TYPES.includes(code.type)) return false;
  if (!Number.isSafeInteger(Number(code.used_by)) || Number(code.used_by) <= 0 || !code.used_at) return false;
  let cents;
  try { cents = BigInt(centsFromUpstream(code.value)); } catch { return false; }
  if (cents <= 0n) return false;
  const normalizedCode = String(code.code || '').trim().toUpperCase();
  if (rewardCodePrefix && normalizedCode.startsWith(rewardCodePrefix.toUpperCase())) return false;
  const notes = String(code.notes || '').toLowerCase();
  if (notes.includes(EXTENSION_NOTES_MARKER)) return false;
  return true;
}

export function normalizeUpstreamUser(user, syncedAt = nowIso(), balanceHistoryTotal = null) {
  const userTotalRecharged = centsFromUpstream(user.total_recharged || 0);
  const historyTotalRecharged = balanceHistoryTotal === null || balanceHistoryTotal === undefined
    ? '0'
    : centsFromUpstream(balanceHistoryTotal);
  return {
    user_id: Number(user.id),
    email: String(user.email || ''),
    username: String(user.username || ''),
    role: String(user.role || 'user'),
    status: String(user.status || ''),
    balance_cents: centsFromUpstream(user.balance || 0),
    total_recharged_cents: BigInt(historyTotalRecharged) > BigInt(userTotalRecharged)
      ? historyTotalRecharged
      : userTotalRecharged,
    allowed_groups_json: JSON.stringify(normalizeAllowedGroups(user.allowed_groups)),
    created_at: validDateOrNow(user.created_at, syncedAt),
    upstream_updated_at: user.updated_at ? validDateOrNull(user.updated_at) : null,
    synced_at: syncedAt
  };
}

function validDateOrNow(value, fallback) {
  return validDateOrNull(value) || fallback;
}

function validDateOrNull(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function upsertSyncedUser(db, upstreamUser, syncedAt = nowIso(), balanceHistoryTotal = null) {
  const user = normalizeUpstreamUser(upstreamUser, syncedAt, balanceHistoryTotal);
  if (!Number.isSafeInteger(user.user_id) || user.user_id <= 0) return false;
  db.prepare(`
    INSERT INTO synced_users(
      user_id, email, username, role, status, balance_cents, total_recharged_cents,
      allowed_groups_json, created_at, upstream_updated_at, synced_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      email = excluded.email,
      username = excluded.username,
      role = excluded.role,
      status = excluded.status,
      balance_cents = excluded.balance_cents,
      total_recharged_cents = excluded.total_recharged_cents,
      allowed_groups_json = excluded.allowed_groups_json,
      created_at = excluded.created_at,
      upstream_updated_at = excluded.upstream_updated_at,
      synced_at = excluded.synced_at
  `).run(
    user.user_id, user.email, user.username, user.role, user.status, user.balance_cents,
    user.total_recharged_cents, user.allowed_groups_json, user.created_at, user.upstream_updated_at, user.synced_at
  );
  return true;
}

export function normalizeAllowedGroups(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(Number).filter((id) => Number.isSafeInteger(id) && id > 0))].sort((a, b) => a - b);
}

export function getRechargeSummary(db, userId, { windowDays = [], now = new Date() } = {}) {
  const rows = db.prepare('SELECT value_cents, used_at FROM recharge_events WHERE user_id = ?').all(userId);
  const recentRechargeTotals = {};
  for (const days of normalizeWindowDays(windowDays)) {
    const cutoff = now.getTime() - days * 86_400_000;
    recentRechargeTotals[String(days)] = addIntegerStrings(rows
      .filter((row) => {
        const usedAt = new Date(row.used_at).getTime();
        return Number.isFinite(usedAt) && usedAt >= cutoff;
      })
      .map((row) => row.value_cents));
  }
  return {
    recharge_count: rows.length,
    recharge_total_cents: addIntegerStrings(rows.map((row) => row.value_cents)),
    recent_recharge_totals_cents: recentRechargeTotals,
    excluded_reward_cents: extensionRewardTotal(db, userId)
  };
}

function normalizeWindowDays(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values
    .map(Number)
    .filter((value) => Number.isSafeInteger(value) && value >= 1 && value <= 365))]
    .sort((left, right) => left - right);
}

export function getAllRechargeSummaries(db) {
  const summaries = new Map();
  for (const row of db.prepare('SELECT user_id, value_cents FROM recharge_events ORDER BY user_id').all()) {
    const existing = summaries.get(row.user_id) || { recharge_count: 0, total: 0n };
    existing.recharge_count += 1;
    existing.total += BigInt(row.value_cents);
    summaries.set(row.user_id, existing);
  }
  const userIds = new Set([
    ...summaries.keys(),
    ...db.prepare('SELECT DISTINCT user_id FROM winners').all().map((row) => row.user_id),
    ...db.prepare('SELECT DISTINCT user_id FROM checkin_records').all().map((row) => row.user_id)
  ]);
  return new Map([...userIds].map((userId) => {
    const value = summaries.get(userId) || { recharge_count: 0, total: 0n };
    return [userId, {
      recharge_count: value.recharge_count,
      recharge_total_cents: value.total.toString(),
      excluded_reward_cents: extensionRewardTotal(db, userId)
    }];
  }));
}

function extensionRewardTotal(db, userId) {
  const values = [];
  const lotteryRows = db.prepare(`
    SELECT p.reward_value FROM winners w
    JOIN prizes p ON p.id = w.prize_id
    JOIN outbox_jobs o ON o.winner_id = w.id
    WHERE w.user_id = ? AND p.reward_type = 'balance' AND o.status = 'succeeded'
  `).all(userId);
  const checkinRows = db.prepare(`
    SELECT c.reward_value FROM checkin_records r
    JOIN checkin_campaigns c ON c.id = r.campaign_id
    WHERE r.user_id = ? AND c.reward_type = 'balance' AND r.reward_status = 'succeeded'
  `).all(userId);
  for (const row of [...lotteryRows, ...checkinRows]) {
    try { values.push(centsFromUpstream(row.reward_value)); } catch { /* ignore invalid historical reward */ }
  }
  return addIntegerStrings(values);
}

export class SyncService {
  constructor(db, client, config) {
    this.db = db;
    this.client = client;
    this.config = config;
    this.running = null;
  }

  run() {
    if (this.running) return this.running;
    this.running = this.#runOnce().finally(() => { this.running = null; });
    return this.running;
  }

  async refreshUser(userId, {
    withRechargeHistory = true,
    rechargeWindowDays = [],
    now = new Date()
  } = {}) {
    const normalizedWindowDays = normalizeWindowDays(rechargeWindowDays);
    const userPromise = this.client.getUser(userId);
    const balanceHistoryPromise = withRechargeHistory
      ? this.client.getUserBalanceHistory(userId)
      : Promise.resolve(null);
    const recentRechargePromise = normalizedWindowDays.length > 0
      ? this.#fetchRecentRechargeEvents(userId, normalizedWindowDays.at(-1), now)
      : Promise.resolve(null);
    const [user, balanceHistory, recentRecharge] = await Promise.all([
      userPromise,
      balanceHistoryPromise,
      recentRechargePromise
    ]);
    transaction(this.db, () => {
      upsertSyncedUser(this.db, user, nowIso(now), balanceHistory?.total_recharged);
      if (recentRecharge) this.#replaceRecentRechargeEvents(userId, recentRecharge, now);
    });
    return this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
  }

  async #fetchRecentRechargeEvents(userId, maxWindowDays, now) {
    const cutoffAt = new Date(now.getTime() - maxWindowDays * 86_400_000).toISOString();
    const events = [];
    for (const type of RECHARGE_TYPES) {
      let page = 1;
      let reachedCutoff = false;
      while (true) {
        const data = await this.client.getUserBalanceHistory(userId, {
          page,
          pageSize: PAGE_SIZE,
          type
        });
        const items = Array.isArray(data?.items) ? data.items : [];
        for (const item of items) {
          const usedAt = validDateOrNull(item.used_at);
          if (usedAt && usedAt < cutoffAt) {
            reachedCutoff = true;
            break;
          }
          events.push(item);
        }
        if (reachedCutoff || page >= Number(data?.pages || 1) || items.length === 0) break;
        page += 1;
      }
    }
    return { cutoff_at: cutoffAt, events };
  }

  #replaceRecentRechargeEvents(userId, recentRecharge, now) {
    this.db.prepare(`
      DELETE FROM recharge_events
      WHERE user_id = ? AND source_type IN ('balance', 'admin_balance') AND used_at >= ?
    `).run(userId, recentRecharge.cutoff_at);
    const statement = this.db.prepare(`
      INSERT INTO recharge_events(source_type, source_id, user_id, value_cents, used_at, code, notes, synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_type, source_id) DO UPDATE SET
        user_id = excluded.user_id,
        value_cents = excluded.value_cents,
        used_at = excluded.used_at,
        code = excluded.code,
        notes = excluded.notes,
        synced_at = excluded.synced_at
    `);
    const syncedAt = nowIso(now);
    for (const item of recentRecharge.events) {
      if (!shouldIncludeRecharge(item, this.config.rewardCodePrefix)) continue;
      const usedAt = validDateOrNull(item.used_at);
      if (!usedAt || usedAt < recentRecharge.cutoff_at) continue;
      statement.run(
        String(item.type),
        String(item.id),
        Number(item.used_by),
        centsFromUpstream(item.value),
        usedAt,
        String(item.code || ''),
        String(item.notes || ''),
        syncedAt
      );
    }
  }

  async refreshGroups() {
    const result = { groups_scanned: 0, groups_updated: 0 };
    await this.#syncGroups(result);
    return result;
  }

  status() {
    return this.db.prepare("SELECT * FROM sync_cursors WHERE source = 'all'").get() || {
      source: 'all', last_status: 'never', item_count: 0
    };
  }

  async #runOnce() {
    const startedAt = nowIso();
    this.#setSyncStatus('all', 'running', startedAt, null, 0);
    const result = {
      started_at: startedAt,
      completed_at: null,
      users_scanned: 0,
      users_updated: 0,
      recharge_events_scanned: 0,
      recharge_events_updated: 0,
      groups_scanned: 0,
      groups_updated: 0,
      errors: 0
    };
    try {
      await this.#syncGroups(result);
      await this.#syncUsers(result);
      for (const type of RECHARGE_TYPES) await this.#syncRedeemCodes(type, result);
      result.completed_at = nowIso();
      this.db.prepare(`
        INSERT INTO sync_cursors(source, cursor_json, last_started_at, last_completed_at, last_status, last_error, item_count)
        VALUES ('all', '{}', ?, ?, 'succeeded', NULL, ?)
        ON CONFLICT(source) DO UPDATE SET
          last_started_at = excluded.last_started_at,
          last_completed_at = excluded.last_completed_at,
          last_status = excluded.last_status,
          last_error = NULL,
          item_count = excluded.item_count
      `).run(startedAt, result.completed_at, result.users_scanned + result.recharge_events_scanned);
      return result;
    } catch (error) {
      result.errors += 1;
      const safeMessage = String(error?.code || error?.name || 'SYNC_FAILED').slice(0, 200);
      this.db.prepare(`
        UPDATE sync_cursors SET last_status = 'failed', last_error = ?, last_completed_at = ? WHERE source = 'all'
      `).run(safeMessage, nowIso());
      throw error;
    }
  }

  async #syncUsers(result) {
    const sweepStartedAt = nowIso();
    let page = 1;
    while (true) {
      const data = await this.client.listUsers(page, PAGE_SIZE);
      const items = Array.isArray(data?.items) ? data.items : [];
      const syncedAt = nowIso();
      transaction(this.db, () => {
        for (const item of items) {
          result.users_scanned += 1;
          if (upsertSyncedUser(this.db, item, syncedAt)) result.users_updated += 1;
        }
      });
      if (page >= Number(data?.pages || 1) || items.length === 0) break;
      page += 1;
    }
    // The users endpoint is a full snapshot. Remove users no longer returned by Sub2API,
    // while preserving any user refreshed concurrently after this sweep began.
    this.db.prepare('DELETE FROM synced_users WHERE synced_at < ?').run(sweepStartedAt);
  }

  async #syncGroups(result) {
    const sweepStartedAt = nowIso();
    let page = 1;
    while (true) {
      const data = await this.client.listGroups(page, PAGE_SIZE);
      const items = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
      transaction(this.db, () => {
        const statement = this.db.prepare(`
          INSERT INTO synced_groups(
            group_id, name, description, platform, status, is_exclusive, rate_multiplier, subscription_type,
            upstream_updated_at, synced_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(group_id) DO UPDATE SET
            name = excluded.name,
            description = excluded.description,
            platform = excluded.platform,
            status = excluded.status,
            is_exclusive = excluded.is_exclusive,
            rate_multiplier = excluded.rate_multiplier,
            subscription_type = excluded.subscription_type,
            upstream_updated_at = excluded.upstream_updated_at,
            synced_at = excluded.synced_at
        `);
        for (const group of items) {
          const groupId = Number(group?.id);
          if (!Number.isSafeInteger(groupId) || groupId <= 0) continue;
          result.groups_scanned += 1;
          statement.run(
            groupId,
            String(group.name || ''),
            String(group.description || ''),
            String(group.platform || ''),
            String(group.status || ''),
            group.is_exclusive ? 1 : 0,
            normalizeRateMultiplier(group.rate_multiplier),
            String(group.subscription_type || ''),
            group.updated_at ? validDateOrNull(group.updated_at) : null,
            nowIso()
          );
          result.groups_updated += 1;
        }
      });
      if (Array.isArray(data) || page >= Number(data?.pages || 1) || items.length === 0) break;
      page += 1;
    }
    this.db.prepare('DELETE FROM synced_groups WHERE synced_at < ?').run(sweepStartedAt);
  }

  async #syncRedeemCodes(type, result) {
    const source = `redeem:${type}`;
    const cursorRow = this.db.prepare('SELECT cursor_json FROM sync_cursors WHERE source = ?').get(source);
    const previousCursor = parseJson(cursorRow?.cursor_json, null);
    let nextCursor = previousCursor && previousCursor.used_at
      ? { used_at: String(previousCursor.used_at), id: Number(previousCursor.id || 0) }
      : null;
    let page = 1;
    let reachedWatermark = false;
    let typeUpdated = 0;
    while (true) {
      const data = await this.client.listRedeemCodes(type, page, PAGE_SIZE);
      const items = Array.isArray(data?.items) ? data.items : [];
      const syncedAt = nowIso();
      transaction(this.db, () => {
        const statement = this.db.prepare(`
          INSERT INTO recharge_events(source_type, source_id, user_id, value_cents, used_at, code, notes, synced_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(source_type, source_id) DO UPDATE SET
            user_id = excluded.user_id,
            value_cents = excluded.value_cents,
            used_at = excluded.used_at,
            code = excluded.code,
            notes = excluded.notes,
            synced_at = excluded.synced_at
        `);
        for (const item of items) {
          const usedAt = validDateOrNull(item.used_at);
          const sourceId = Number(item.id || 0);
          if (previousCursor && usedAt && (
            usedAt < previousCursor.used_at
            || (usedAt === previousCursor.used_at && sourceId <= previousCursor.id)
          )) {
            // Sub2API applies id DESC as the stable secondary order. Once the
            // previous (used_at, id) watermark is reached, all following rows
            // are already known and no later page can contain a newer record.
            reachedWatermark = true;
            break;
          }
          result.recharge_events_scanned += 1;
          if (usedAt && (!nextCursor || usedAt > nextCursor.used_at || (usedAt === nextCursor.used_at && sourceId > nextCursor.id))) {
            nextCursor = { used_at: usedAt, id: sourceId };
          }
          if (!shouldIncludeRecharge(item, this.config.rewardCodePrefix)) {
            this.db.prepare('DELETE FROM recharge_events WHERE source_type = ? AND source_id = ?')
              .run(type, String(item.id));
            continue;
          }
          statement.run(
            type,
            String(item.id),
            Number(item.used_by),
            centsFromUpstream(item.value),
            usedAt || syncedAt,
            String(item.code || ''),
            String(item.notes || ''),
            syncedAt
          );
          result.recharge_events_updated += 1;
          typeUpdated += 1;
        }
      });
      if (reachedWatermark || page >= Number(data?.pages || 1) || items.length === 0) break;
      page += 1;
    }
    this.db.prepare(`
      INSERT INTO sync_cursors(source, cursor_json, last_started_at, last_completed_at, last_status, last_error, item_count)
      VALUES (?, ?, NULL, ?, 'succeeded', NULL, ?)
      ON CONFLICT(source) DO UPDATE SET cursor_json = excluded.cursor_json,
        last_completed_at = excluded.last_completed_at, last_status = excluded.last_status,
        last_error = NULL, item_count = excluded.item_count
    `).run(source, JSON.stringify(nextCursor || {}), nowIso(), typeUpdated);
  }

  #setSyncStatus(source, status, startedAt, error, itemCount) {
    this.db.prepare(`
      INSERT INTO sync_cursors(source, cursor_json, last_started_at, last_status, last_error, item_count)
      VALUES (?, '{}', ?, ?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_started_at = excluded.last_started_at,
        last_status = excluded.last_status, last_error = excluded.last_error, item_count = excluded.item_count
    `).run(source, startedAt, status, error, itemCount);
  }
}

function normalizeRateMultiplier(value) {
  const multiplier = Number(value);
  return Number.isFinite(multiplier) && multiplier > 0 ? multiplier : 1;
}
