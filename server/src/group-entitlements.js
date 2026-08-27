import { audit, nowIso, parseJson, transaction } from './db.js';
import { badRequest, conflict, notFound } from './errors.js';
import {
  conditionFromApi,
  conditionToApi,
  evaluateRule,
  factsToApi,
  makeUserFacts,
  rechargeWindowDays
} from './rules.js';
import { getRechargeSummary, normalizeAllowedGroups, upsertSyncedUser } from './sync.js';
import { boolean, objectBody, optionalString, positiveId, requiredString } from './validation.js';

export class GroupEntitlementService {
  constructor(db, client, syncService, config = {}) {
    this.db = db;
    this.client = client;
    this.syncService = syncService;
    this.config = config;
    this.running = new Map();
    this.userLocks = new Map();
    this.expiryTimer = null;
    this.expiring = false;
    this.scheduledRunning = false;
  }

  async groups(refresh = true) {
    if (refresh) await this.syncService.refreshGroups();
    const rows = this.db.prepare(`
      SELECT g.*, r.id AS rule_id, r.enabled AS rule_enabled
      FROM synced_groups g LEFT JOIN group_entitlement_rules r ON r.group_id = g.group_id
      ORDER BY g.name ASC, g.group_id ASC
    `).all();
    return { items: rows.map(groupToApi), total: rows.length };
  }

  listRules() {
    const rows = this.db.prepare(ruleSelectSql('ORDER BY r.id DESC')).all();
    return { items: rows.map((row) => this.#ruleToApi(row)), total: rows.length };
  }

  getRule(idValue) {
    const id = positiveId(idValue);
    const row = this.db.prepare(ruleSelectSql('WHERE r.id = ?')).get(id);
    if (!row) throw notFound('分组授权规则');
    return this.#ruleToApi(row);
  }

  async createRule(input, actorUserId) {
    await this.syncService.refreshGroups();
    const value = normalizeRuleInput(input);
    this.#requireAssignableGroup(value.group_id);
    if (this.db.prepare('SELECT id FROM group_entitlement_rules WHERE group_id = ?').get(value.group_id)) {
      throw conflict('GROUP_RULE_EXISTS', '每个 Sub2API 分组最多只能配置一条授权规则');
    }
    const timestamp = nowIso();
    const id = transaction(this.db, () => {
      const result = this.db.prepare(`
        INSERT INTO group_entitlement_rules(
          name, group_id, enabled, revoke_when_ineligible, condition_json,
          assignment_mode, activity_description, activity_starts_at, activity_ends_at, revoke_at,
          concurrency_limit,
          created_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        value.name, value.group_id, value.enabled ? 1 : 0,
        value.revoke_when_ineligible ? 1 : 0, JSON.stringify(value.condition),
        value.assignment_mode, value.activity_description, value.activity_starts_at, value.activity_ends_at,
        value.revoke_at, value.concurrency_limit,
        actorUserId, timestamp, timestamp
      );
      const ruleId = Number(result.lastInsertRowid);
      audit(this.db, actorUserId, 'group_rule.created', 'group_entitlement_rule', ruleId, {
        group_id: value.group_id,
        enabled: value.enabled,
        revoke_when_ineligible: value.revoke_when_ineligible
      });
      return ruleId;
    });
    return this.getRule(id);
  }

  async updateRule(idValue, input, actorUserId) {
    const id = positiveId(idValue);
    const existing = this.#rawRule(id);
    await this.syncService.refreshGroups();
    const value = normalizeRuleInput(input, existing);
    if (value.group_id !== existing.group_id) {
      throw badRequest('GROUP_IMMUTABLE', '规则创建后不能更换 Sub2API 分组，请删除后重新创建');
    }
    if (value.enabled) this.#requireAssignableGroup(value.group_id);
    else this.#requireGroup(value.group_id);
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE group_entitlement_rules SET name = ?, enabled = ?, revoke_when_ineligible = ?,
          condition_json = ?, assignment_mode = ?, activity_description = ?,
          activity_starts_at = ?, activity_ends_at = ?, revoke_at = ?, concurrency_limit = ?,
          updated_at = ? WHERE id = ?
      `).run(
        value.name, value.enabled ? 1 : 0, value.revoke_when_ineligible ? 1 : 0,
        JSON.stringify(value.condition), value.assignment_mode, value.activity_description,
        value.activity_starts_at, value.activity_ends_at, value.revoke_at, value.concurrency_limit, nowIso(), id
      );
      audit(this.db, actorUserId, 'group_rule.updated', 'group_entitlement_rule', id, {
        group_id: existing.group_id,
        enabled: value.enabled,
        revoke_when_ineligible: value.revoke_when_ineligible
      });
    });
    return this.getRule(id);
  }

  async deleteRule(idValue, actorUserId) {
    const id = positiveId(idValue);
    const rule = this.#rawRule(id);
    const result = await this.execute(id, actorUserId, { forceRevoke: true, mode: 'revoke', skipSync: true });
    if (result.failed_count > 0) {
      throw conflict('GROUP_REVOKE_INCOMPLETE', '仍有扩展管理的分组授权未能撤销，规则未删除');
    }
    transaction(this.db, () => {
      this.db.prepare('DELETE FROM group_entitlement_rules WHERE id = ?').run(id);
      audit(this.db, actorUserId, 'group_rule.deleted', 'group_entitlement_rule', id, {
        group_id: rule.group_id,
        revoked_count: result.revoked_count
      });
    });
    return result;
  }

  async revokeNow(idValue, actorUserId) {
    const id = positiveId(idValue);
    const rule = this.#rawRule(id);
    const disabledAt = nowIso();
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE group_entitlement_rules SET enabled = 0, updated_at = ? WHERE id = ?
      `).run(disabledAt, id);
      audit(this.db, actorUserId, 'group_rule.revoke_requested', 'group_entitlement_rule', id, {
        group_id: rule.group_id,
        scheduled_revoke_at: rule.revoke_at || null
      });
    });
    const result = await this.execute(id, actorUserId, {
      forceRevoke: true,
      mode: 'revoke',
      skipSync: true
    });
    audit(this.db, actorUserId, 'group_rule.revoked_early', 'group_entitlement_rule', id, {
      group_id: rule.group_id,
      status: result.status,
      revoked_count: result.revoked_count,
      failed_count: result.failed_count
    });
    if (result.failed_count > 0) {
      throw conflict('GROUP_REVOKE_INCOMPLETE', '仍有活动分组未能撤销，活动已停用，请稍后重试提前撤销');
    }
    return result;
  }

  async preview(idValue, actorUserId) {
    const id = positiveId(idValue);
    const rule = this.#rawRule(id);
    throw conflict('GROUP_RULE_CLAIM_ONLY', `“${rule.name}”仅支持用户手动申请，不能批量预览或授权`);
  }

  async execute(idValue, actorUserId, options = {}) {
    const id = positiveId(idValue);
    const existing = this.running.get(id);
    if (existing) {
      await existing;
      return this.execute(id, actorUserId, options);
    }
    const promise = this.#executeOnce(id, actorUserId, options).finally(() => this.running.delete(id));
    this.running.set(id, promise);
    return promise;
  }

  startExpiryRevocations() {
    if (this.expiryTimer) return;
    const interval = Number(this.config.groupExpiryIntervalMs) || 10_000;
    this.expiryTimer = setInterval(() => {
      this.runScheduledTasks().catch(() => { /* unfinished tasks retry on the next interval */ });
    }, interval);
    this.expiryTimer.unref?.();
    setImmediate(() => this.runScheduledTasks().catch(() => {}));
  }

  stopExpiryRevocations() {
    if (this.expiryTimer) clearInterval(this.expiryTimer);
    this.expiryTimer = null;
  }

  async runScheduledTasks(options = {}) {
    if (this.scheduledRunning) return [];
    this.scheduledRunning = true;
    try {
      const restored = await this.restoreScheduledConcurrency(options);
      const revoked = await this.executeScheduled(options);
      return [...restored, ...revoked];
    } finally {
      this.scheduledRunning = false;
    }
  }

  async restoreScheduledConcurrency({ limit = 100 } = {}) {
    const now = nowIso();
    const rows = this.db.prepare(`
      SELECT o.id, o.rule_id, o.user_id, o.status,
        COALESCE(r.activity_ends_at, r.revoke_at) AS restore_at
      FROM group_entitlement_concurrency_overrides o
      JOIN group_entitlement_rules r ON r.id = o.rule_id
      WHERE r.assignment_mode = 'claim'
        AND COALESCE(r.activity_ends_at, r.revoke_at) IS NOT NULL
        AND COALESCE(r.activity_ends_at, r.revoke_at) <= ?
        AND o.status IN ('active', 'pending', 'failed')
      ORDER BY COALESCE(r.activity_ends_at, r.revoke_at) ASC, o.id ASC
      LIMIT ?
    `).all(now, Math.max(1, Math.min(500, Number(limit) || 100)));
    const results = [];
    for (const row of rows) {
      try {
        await this.#withUserLock(row.user_id, async () => {
          const override = this.db.prepare(`
            SELECT * FROM group_entitlement_concurrency_overrides
            WHERE id = ? AND status IN ('active', 'pending', 'failed')
          `).get(row.id);
          if (!override) return;
          const rule = this.#rawRule(row.rule_id);
          let upstream;
          try {
            upstream = await this.client.getUser(row.user_id);
          } catch (error) {
            if (error?.upstreamStatus === 404) {
              this.#markConcurrencyOverrideRestored(override.id);
              results.push({ id: Number(override.id), status: 'restored', user_id: Number(row.user_id) });
              return;
            }
            throw error;
          }
          upsertSyncedUser(this.db, upstream);
          const user = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(row.user_id);
          if (!user) throw notFound('用户');
          const restore = this.#concurrencyRestore(rule, row.user_id);
          if (!restore) return;
          if (Number(user.concurrency) !== restore.concurrency) {
            const updated = await this.client.updateUserConcurrency(row.user_id, restore.concurrency);
            this.#storeUpdatedUser(user, updated, normalizeAllowedGroups(parseJson(user.allowed_groups_json, [])), restore.concurrency);
          }
          this.#markConcurrencyOverrideRestored(restore.id);
          results.push({
            id: Number(restore.id),
            rule_id: Number(row.rule_id),
            user_id: Number(row.user_id),
            status: 'restored',
            concurrency: restore.concurrency
          });
          audit(this.db, null, 'group_concurrency.restored', 'user', row.user_id, {
            rule_id: row.rule_id,
            restored_concurrency: restore.concurrency,
            restore_at: row.restore_at
          });
        });
      } catch (error) {
        this.#markConcurrencyOverrideFailed(row.id, error);
        results.push({
          id: Number(row.id),
          rule_id: Number(row.rule_id),
          user_id: Number(row.user_id),
          status: 'failed',
          error: String(error?.message || '并发恢复失败')
        });
        audit(this.db, null, 'group_concurrency.restore_failed', 'user', row.user_id, {
          rule_id: row.rule_id,
          restore_at: row.restore_at,
          code: String(error?.code || 'GROUP_CONCURRENCY_RESTORE_FAILED'),
          message: String(error?.message || '并发恢复失败').slice(0, 500)
        });
      }
    }
    return results;
  }

  async executeScheduled(options = {}) {
    return this.#executeScheduledRevocations(options);
  }

  async #executeScheduledRevocations({ limit = 10 } = {}) {
    if (this.expiring) return [];
    this.expiring = true;
    const results = [];
    try {
      const rows = this.db.prepare(`
        SELECT r.id, r.group_id, r.revoke_at
        FROM group_entitlement_rules r
        WHERE r.assignment_mode = 'claim'
          AND r.revoke_at IS NOT NULL
          AND r.revoke_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM group_entitlement_runs run
            WHERE run.rule_id = r.id
              AND run.mode = 'expire'
              AND run.status = 'succeeded'
              AND run.started_at >= r.updated_at
              AND run.started_at >= r.revoke_at
          )
        ORDER BY r.revoke_at ASC, r.id ASC
        LIMIT ?
      `).all(nowIso(), Math.max(1, Math.min(100, Number(limit) || 10)));
      for (const row of rows) {
        const releaseRuleLock = await this.#tryAcquireDistributedRuleLock(row.id);
        if (!releaseRuleLock) continue;
        try {
          const result = await this.execute(row.id, null, {
            forceRevoke: true,
            mode: 'expire',
            skipSync: true
          });
          results.push(result);
          audit(this.db, null, 'group_rule.expiry_processed', 'group_entitlement_rule', row.id, {
            group_id: row.group_id,
            revoke_at: row.revoke_at,
            status: result.status,
            revoked_count: result.revoked_count,
            failed_count: result.failed_count
          });
        } catch (error) {
          results.push({
            rule_id: String(row.id),
            group_id: Number(row.group_id),
            mode: 'expire',
            status: 'failed',
            revoked_count: 0,
            failed_count: 1,
            error: String(error?.message || '到期撤销失败')
          });
          audit(this.db, null, 'group_rule.expiry_failed', 'group_entitlement_rule', row.id, {
            group_id: row.group_id,
            revoke_at: row.revoke_at,
            code: String(error?.code || 'GROUP_EXPIRY_FAILED'),
            message: String(error?.message || '到期撤销失败').slice(0, 500)
          });
        } finally {
          try { releaseRuleLock(); } catch { /* connection close also releases PostgreSQL advisory locks */ }
        }
      }
      return results;
    } finally {
      this.expiring = false;
    }
  }

  async claim(idValue, userIdValue) {
    const id = positiveId(idValue);
    const userId = positiveId(userIdValue, 'user_id');
    this.#requireClaimable(this.#rawRule(id));
    return this.#withUserLock(userId, async () => {
      // Recheck after acquiring the user lock so a request queued at the end
      // boundary cannot outlive the expiry revocation.
      const rule = this.#rawRule(id);
      this.#requireClaimable(rule);
      const windowDays = rechargeWindowDays(rule.condition);
      const evaluatedAt = new Date();
      const user = await this.syncService.refreshUser(userId, {
        rechargeWindowDays: windowDays,
        now: evaluatedAt
      });
      const membership = this.#membership(rule.group_id, userId);
      const decision = decide(
        rule,
        user,
        getRechargeSummary(this.db, userId, { windowDays, now: evaluatedAt }),
        membership,
        false
      );
      const alreadyGranted = decision.has_group;
      if (!decision.matched) {
        audit(this.db, userId, 'group_claim.denied', 'group_entitlement_rule', id, {
          group_id: rule.group_id,
          reasons: decision.reasons
        });
        return claimResult(rule, decision, { granted: false, alreadyGranted: false });
      }

      const summary = emptySummary(rule, null, 'execute');
      summary.scanned_count = 1;
      summary.eligible_count = 1;
      await this.#applyDecision(rule, user, membership, decision, userId, summary);
      audit(this.db, userId, 'group_claim.completed', 'group_entitlement_rule', id, {
        group_id: rule.group_id,
        already_granted: alreadyGranted,
        granted_count: summary.grant_count
      });
      return claimResult(rule, decision, { granted: true, alreadyGranted });
    });
  }

  async claimState(idValue, userIdValue, { refresh = false } = {}) {
    const id = positiveId(idValue);
    const userId = positiveId(userIdValue, 'user_id');
    const rule = this.#rawRule(id);
    const windowDays = rechargeWindowDays(rule.condition);
    const evaluatedAt = new Date();
    if (refresh) {
      await this.syncService.refreshUser(userId, {
        rechargeWindowDays: windowDays,
        now: evaluatedAt
      });
    }
    const user = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(userId);
    if (!user) throw notFound('用户');
    const membership = this.#membership(rule.group_id, userId);
    const decision = decide(
      rule,
      user,
      getRechargeSummary(this.db, userId, { windowDays, now: evaluatedAt }),
      membership,
      false
    );
    return claimResult(rule, decision, {
      granted: decision.has_group,
      alreadyGranted: decision.has_group
    });
  }

  runs(ruleIdValue = null, limitValue = 50) {
    const limit = Math.min(200, Math.max(1, Number(limitValue) || 50));
    let rows;
    if (ruleIdValue !== null && ruleIdValue !== undefined && ruleIdValue !== '') {
      rows = this.db.prepare(`
        SELECT * FROM group_entitlement_runs WHERE rule_id = ? ORDER BY id DESC LIMIT ?
      `).all(positiveId(ruleIdValue, 'rule_id'), limit);
    } else {
      rows = this.db.prepare('SELECT * FROM group_entitlement_runs ORDER BY id DESC LIMIT ?').all(limit);
    }
    const total = ruleIdValue
      ? Number(this.db.prepare('SELECT COUNT(*) AS count FROM group_entitlement_runs WHERE rule_id = ?').get(Number(ruleIdValue)).count)
      : Number(this.db.prepare('SELECT COUNT(*) AS count FROM group_entitlement_runs').get().count);
    return { items: rows.map(runToApi), total };
  }

  async #executeOnce(id, actorUserId, { forceRevoke = false, mode = 'execute', skipSync = false } = {}) {
    const rule = this.#rawRule(id);
    if (!forceRevoke && !Boolean(rule.enabled)) {
      throw conflict('GROUP_RULE_DISABLED', '分组授权规则已停用');
    }
    if (!forceRevoke) {
      throw conflict('GROUP_RULE_CLAIM_ONLY', '分组资格只能由用户手动申请，不能批量执行授权');
    }
    if (!skipSync) await this.syncService.run();
    const group = forceRevoke
      ? (this.#findGroup(rule.group_id) || { name: '' })
      : this.#requireAssignableGroup(rule.group_id);
    const startedAt = nowIso();
    const runId = Number(this.db.prepare(`
      INSERT INTO group_entitlement_runs(
        rule_id, group_id, rule_name, group_name, mode, status, actor_user_id, started_at
      ) VALUES (?, ?, ?, ?, ?, 'running', ?, ?)
    `).run(
      id, rule.group_id, rule.name, group.name, mode, actorUserId ?? null, startedAt
    ).lastInsertRowid);
    const summary = emptySummary(rule, runId, mode);
    const users = forceRevoke
      ? this.db.prepare(`
        SELECT u.* FROM group_entitlement_memberships m
        JOIN synced_users u ON u.user_id = m.user_id
        WHERE m.rule_id = ? AND m.ownership = 'managed' AND m.status = 'active'
        ORDER BY u.user_id ASC
      `).all(rule.id)
      : this.db.prepare('SELECT * FROM synced_users ORDER BY user_id ASC').all();
    for (const snapshot of users) {
      summary.scanned_count += 1;
      try {
        await this.#withUserLock(snapshot.user_id, async () => {
          let current = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(snapshot.user_id);
          if (!current) return;
          let membership = this.#membership(rule.group_id, current.user_id);
          const rechargeSummary = getRechargeSummary(this.db, current.user_id, {
            windowDays: rechargeWindowDays(rule.condition)
          });
          let decision = decide(rule, current, rechargeSummary, membership, forceRevoke);

          // The preceding full sync is enough for unchanged users. Re-read only
          // users about to be changed, then rebuild the decision from their latest
          // allowed_groups so unrelated manual group edits are never overwritten.
          if (decision.action === 'grant' || decision.action === 'revoke_managed') {
            const upstream = await this.client.getUser(snapshot.user_id);
            upsertSyncedUser(this.db, upstream);
            current = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(snapshot.user_id);
            membership = this.#membership(rule.group_id, current.user_id);
            decision = decide(rule, current, rechargeSummary, membership, forceRevoke);
          }
          if (decision.matched) summary.eligible_count += 1;
          await this.#applyDecision(rule, current, membership, decision, actorUserId, summary);
        });
      } catch (error) {
        summary.error_count += 1;
        if (summary.errors.length < 100) {
          summary.errors.push({ user_id: snapshot.user_id, code: String(error?.code || 'USER_UPDATE_FAILED') });
        }
      }
    }
    await this.#reconcileMissingUsers(rule, actorUserId, summary, forceRevoke);
    const completedAt = nowIso();
    const status = summary.error_count > 0 ? (summary.grant_count + summary.revoke_count > 0 ? 'partial' : 'failed') : 'succeeded';
    transaction(this.db, () => {
      this.db.prepare(`
        UPDATE group_entitlement_runs SET status = ?, eligible_count = ?, grant_count = ?,
          revoke_count = ?, managed_count = ?, preexisting_count = ?, unchanged_count = ?,
          error_count = ?, result_json = ?, completed_at = ? WHERE id = ?
      `).run(
        status, summary.eligible_count, summary.grant_count, summary.revoke_count,
        summary.managed_count, summary.preexisting_count, summary.unchanged_count,
        summary.error_count,
        JSON.stringify({ errors: summary.errors, scanned_count: summary.scanned_count }),
        completedAt,
        runId
      );
      this.db.prepare('UPDATE group_entitlement_rules SET last_executed_at = ? WHERE id = ?').run(completedAt, id);
      audit(this.db, actorUserId, 'group_rule.executed', 'group_entitlement_rule', id, {
        run_id: runId,
        group_id: rule.group_id,
        status,
        grant_count: summary.grant_count,
        revoke_count: summary.revoke_count,
        error_count: summary.error_count
      });
    });
    return runToApi(this.db.prepare('SELECT * FROM group_entitlement_runs WHERE id = ?').get(runId));
  }

  async #applyDecision(rule, user, membership, decision, actorUserId, summary) {
    const timestamp = nowIso();
    if (decision.action === 'grant') {
      const next = unionGroups(decision.allowed_groups, rule.group_id);
      const override = this.#prepareConcurrencyOverride(rule, user.user_id, user.concurrency);
      let updated;
      try {
        updated = await this.client.updateUserAllowedGroups(
          user.user_id,
          next,
          override?.applied_concurrency
        );
      } catch (error) {
        if (override) this.#markConcurrencyOverrideFailed(override.id, error);
        throw error;
      }
      this.#storeUpdatedUser(user, updated, next, override?.applied_concurrency);
      if (override) this.#markConcurrencyOverrideApplied(override.id);
      // Only claim managed ownership after Sub2API confirms the write. If the
      // process dies between those steps, the next run treats the grant as
      // preexisting, which favors never revoking a permission of uncertain origin.
      this.#upsertMembership(rule, user.user_id, 'managed', 'active', 'granted', timestamp);
      summary.grant_count += 1;
      audit(this.db, actorUserId, 'group_membership.granted', 'user', user.user_id, {
        group_id: rule.group_id,
        concurrency_limit: rule.concurrency_limit ?? null
      });
      return;
    }
    if (decision.action === 'revoke_managed') {
      const next = differenceGroup(decision.allowed_groups, rule.group_id);
      const restore = this.#concurrencyRestore(rule, user.user_id);
      let updated;
      try {
        updated = await this.client.updateUserAllowedGroups(user.user_id, next, restore?.concurrency);
      } catch (error) {
        if (restore) this.#markConcurrencyOverrideFailed(restore.id, error);
        throw error;
      }
      this.#storeUpdatedUser(user, updated, next, restore?.concurrency);
      if (restore) this.#markConcurrencyOverrideRestored(restore.id);
      this.#upsertMembership(rule, user.user_id, 'managed', 'revoked', 'revoked', timestamp);
      summary.revoke_count += 1;
      audit(this.db, actorUserId, 'group_membership.revoked', 'user', user.user_id, {
        group_id: rule.group_id,
        restored_concurrency: restore?.concurrency ?? null
      });
      return;
    }
    if (decision.action === 'keep_managed') {
      const override = this.#prepareConcurrencyOverride(rule, user.user_id, user.concurrency);
      if (override && Number(user.concurrency) !== override.applied_concurrency) {
        try {
          const updated = await this.client.updateUserConcurrency(user.user_id, override.applied_concurrency);
          this.#storeUpdatedUser(user, updated, decision.allowed_groups, override.applied_concurrency);
          this.#markConcurrencyOverrideApplied(override.id);
        } catch (error) {
          this.#markConcurrencyOverrideFailed(override.id, error);
          throw error;
        }
      } else if (override) {
        this.#markConcurrencyOverrideApplied(override.id);
      }
      this.#upsertMembership(rule, user.user_id, 'managed', 'active', 'retained', timestamp);
      summary.managed_count += 1;
      return;
    }
    if (decision.action === 'keep_preexisting') {
      this.#upsertMembership(rule, user.user_id, 'preexisting', 'active', 'observed', timestamp);
      summary.preexisting_count += 1;
      return;
    }
    if (membership?.status === 'active' && !decision.has_group) {
      const restore = this.#concurrencyRestore(rule, user.user_id);
      if (restore) {
        try {
          const updated = await this.client.updateUserConcurrency(user.user_id, restore.concurrency);
          this.#storeUpdatedUser(user, updated, decision.allowed_groups, restore.concurrency);
          this.#markConcurrencyOverrideRestored(restore.id);
        } catch (error) {
          this.#markConcurrencyOverrideFailed(restore.id, error);
          throw error;
        }
      }
      this.#upsertMembership(rule, user.user_id, membership.ownership, 'revoked', 'missing_upstream', timestamp);
    }
    summary.unchanged_count += 1;
  }

  async #reconcileMissingUsers(rule, actorUserId, summary, forceRevoke) {
    const rows = this.db.prepare(`
      SELECT m.* FROM group_entitlement_memberships m
      LEFT JOIN synced_users u ON u.user_id = m.user_id
      WHERE m.rule_id = ? AND m.ownership = 'managed' AND m.status = 'active' AND u.user_id IS NULL
    `).all(rule.id);
    for (const row of rows) {
      summary.scanned_count += 1;
      try {
        await this.#withUserLock(row.user_id, async () => {
          const upstream = await this.client.getUser(row.user_id);
          upsertSyncedUser(this.db, upstream);
          const current = this.db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(row.user_id);
          const membership = this.#membership(rule.group_id, row.user_id);
          const rechargeSummary = getRechargeSummary(this.db, row.user_id, {
            windowDays: rechargeWindowDays(rule.condition)
          });
          const decision = decide(rule, current, rechargeSummary, membership, forceRevoke);
          if (decision.matched) summary.eligible_count += 1;
          await this.#applyDecision(rule, current, membership, decision, actorUserId, summary);
        });
      } catch (error) {
        if (error?.upstreamStatus === 404) {
          this.#upsertMembership(rule, row.user_id, 'managed', 'revoked', 'user_missing_confirmed', nowIso());
          summary.revoke_count += 1;
          audit(this.db, actorUserId, 'group_membership.user_missing', 'user', row.user_id, {
            group_id: rule.group_id,
            upstream_status: 404
          });
          continue;
        }
        summary.error_count += 1;
        if (summary.errors.length < 100) {
          summary.errors.push({ user_id: row.user_id, code: 'USER_RECHECK_FAILED' });
        }
      }
    }
  }

  #upsertMembership(rule, userId, ownership, status, action, timestamp) {
    this.db.prepare(`
      INSERT INTO group_entitlement_memberships(
        group_id, user_id, rule_id, ownership, status, first_seen_at,
        granted_at, revoked_at, last_seen_at, last_action
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(group_id, user_id) DO UPDATE SET
        rule_id = excluded.rule_id,
        ownership = excluded.ownership,
        status = excluded.status,
        granted_at = CASE WHEN excluded.status = 'active' AND excluded.ownership = 'managed'
          THEN COALESCE(group_entitlement_memberships.granted_at, excluded.granted_at)
          ELSE group_entitlement_memberships.granted_at END,
        revoked_at = CASE WHEN excluded.status = 'revoked' THEN excluded.revoked_at ELSE NULL END,
        last_seen_at = excluded.last_seen_at,
        last_action = excluded.last_action
    `).run(
      rule.group_id, userId, rule.id, ownership, status, timestamp,
      ownership === 'managed' && status === 'active' ? timestamp : null,
      status === 'revoked' ? timestamp : null, timestamp, action
    );
  }

  #membership(groupId, userId) {
    return this.db.prepare(`
      SELECT * FROM group_entitlement_memberships WHERE group_id = ? AND user_id = ?
    `).get(groupId, userId);
  }

  #storeUpdatedUser(user, updated, allowedGroups, fallbackConcurrency = undefined) {
    const hasUpdatedUser = updated && Number(updated.id) === Number(user.user_id);
    const confirmedGroups = hasUpdatedUser && Array.isArray(updated.allowed_groups)
      ? normalizeAllowedGroups(updated.allowed_groups)
      : normalizeAllowedGroups(allowedGroups);
    const confirmedConcurrency = hasUpdatedUser && Number.isSafeInteger(Number(updated.concurrency))
      ? Number(updated.concurrency)
      : (fallbackConcurrency === undefined ? Number(user.concurrency) || 0 : Number(fallbackConcurrency));
    this.db.prepare(`
      UPDATE synced_users SET allowed_groups_json = ?, concurrency = ?, synced_at = ? WHERE user_id = ?
    `).run(JSON.stringify(confirmedGroups), confirmedConcurrency, nowIso(), user.user_id);
  }

  #prepareConcurrencyOverride(rule, userId, currentConcurrency) {
    if (rule.concurrency_limit === null || rule.concurrency_limit === undefined) return null;
    const appliedConcurrency = Number(rule.concurrency_limit);
    if (!Number.isSafeInteger(appliedConcurrency) || appliedConcurrency < 1) return null;
    const existing = this.db.prepare(`
      SELECT * FROM group_entitlement_concurrency_overrides
      WHERE rule_id = ? AND user_id = ?
    `).get(rule.id, userId);
    const originalConcurrency = existing && ['active', 'pending', 'failed'].includes(existing.status)
      ? Number(existing.original_concurrency)
      : Number(currentConcurrency) || 0;
    const createdAt = nowIso();
    const id = this.db.prepare(`
      INSERT INTO group_entitlement_concurrency_overrides(
        rule_id, group_id, user_id, original_concurrency, applied_concurrency, status, created_at
      ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
      ON CONFLICT(rule_id, user_id) DO UPDATE SET
        group_id = excluded.group_id,
        original_concurrency = excluded.original_concurrency,
        applied_concurrency = excluded.applied_concurrency,
        status = 'pending',
        applied_at = NULL,
        restored_at = NULL,
        last_error = NULL
      RETURNING id
    `).run(
      rule.id, rule.group_id, userId, originalConcurrency, appliedConcurrency, createdAt
    ).lastInsertRowid;
    return {
      id: Number(id),
      original_concurrency: originalConcurrency,
      applied_concurrency: appliedConcurrency
    };
  }

  #markConcurrencyOverrideApplied(id) {
    this.db.prepare(`
      UPDATE group_entitlement_concurrency_overrides
      SET status = 'active', applied_at = COALESCE(applied_at, ?), last_error = NULL
      WHERE id = ?
    `).run(nowIso(), id);
  }

  #markConcurrencyOverrideFailed(id, error) {
    this.db.prepare(`
      UPDATE group_entitlement_concurrency_overrides
      SET status = 'failed', last_error = ?
      WHERE id = ?
    `).run(String(error?.message || error?.code || '并发数更新失败').slice(0, 500), id);
  }

  #markConcurrencyOverrideRestored(id) {
    this.db.prepare(`
      UPDATE group_entitlement_concurrency_overrides
      SET status = 'restored', restored_at = ?, last_error = NULL
      WHERE id = ?
    `).run(nowIso(), id);
  }

  #concurrencyRestore(rule, userId) {
    const override = this.db.prepare(`
      SELECT * FROM group_entitlement_concurrency_overrides
      WHERE rule_id = ? AND user_id = ? AND status IN ('active', 'pending', 'failed')
    `).get(rule.id, userId);
    if (!override) return null;
    const others = this.db.prepare(`
      SELECT o.id, o.original_concurrency, o.applied_concurrency
      FROM group_entitlement_concurrency_overrides o
      WHERE o.user_id = ? AND o.id <> ? AND o.status IN ('active', 'pending', 'failed')
      ORDER BY o.id ASC
    `).all(userId, override.id);
    // Treat overrides as a stack. The earliest remaining row owns the baseline
    // from before the overlapping activities; carry it to the newest row so
    // restoring activities in any end-time order still reaches that baseline.
    const other = others.at(-1);
    const baseline = others.length && Number(others[0].id) < Number(override.id)
      ? Number(others[0].original_concurrency)
      : Number(override.original_concurrency);
    if (other && Number(other.original_concurrency) !== baseline) {
      this.db.prepare(`
        UPDATE group_entitlement_concurrency_overrides
        SET original_concurrency = ? WHERE id = ?
      `).run(baseline, other.id);
    }
    return {
      id: Number(override.id),
      concurrency: other ? Number(other.applied_concurrency) : baseline
    };
  }

  async #withUserLock(userId, callback) {
    const key = Number(userId);
    const previous = this.userLocks.get(key) || Promise.resolve();
    let release;
    const turn = new Promise((resolve) => { release = resolve; });
    this.userLocks.set(key, turn);
    await previous;
    let releaseDistributed = null;
    try {
      releaseDistributed = await this.#acquireDistributedUserLock(key);
      return await callback();
    } finally {
      try { releaseDistributed?.(); } catch { /* connection close also releases PostgreSQL advisory locks */ }
      release();
      if (this.userLocks.get(key) === turn) this.userLocks.delete(key);
    }
  }

  async #acquireDistributedUserLock(userId) {
    if (this.db.dialect !== 'postgres') return null;
    const lockName = `sub2api-extension:group-user:${userId}`;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const row = this.db.prepare('SELECT pg_try_advisory_lock(hashtext(?)) AS acquired').get(lockName);
      if (row?.acquired) {
        return () => this.db.prepare('SELECT pg_advisory_unlock(hashtext(?)) AS released').get(lockName);
      }
      await delay(50);
    }
    throw conflict('GROUP_CLAIM_BUSY', '该用户的资格申请正在处理中，请稍后重试');
  }

  async #tryAcquireDistributedRuleLock(ruleId) {
    if (this.db.dialect !== 'postgres') return () => {};
    const lockName = `sub2api-extension:group-expiry:${ruleId}`;
    const row = this.db.prepare('SELECT pg_try_advisory_lock(hashtext(?)) AS acquired').get(lockName);
    if (!row?.acquired) return null;
    return () => this.db.prepare('SELECT pg_advisory_unlock(hashtext(?)) AS released').get(lockName);
  }

  #rawRule(id) {
    const row = this.db.prepare(`
      SELECT r.*, g.name AS group_name
      FROM group_entitlement_rules r
      LEFT JOIN synced_groups g ON g.group_id = r.group_id
      WHERE r.id = ?
    `).get(id);
    if (!row) throw notFound('分组授权规则');
    return {
      ...row,
      name: row.name || `${row.group_name || `分组 #${row.group_id}`} 资格申请`,
      condition: parseJson(row.condition_json)
    };
  }

  #findGroup(groupId) {
    return this.db.prepare('SELECT * FROM synced_groups WHERE group_id = ?').get(groupId) || null;
  }

  #requireGroup(groupId) {
    const row = this.#findGroup(groupId);
    if (!row) throw notFound('Sub2API 分组');
    return row;
  }

  #requireAssignableGroup(groupId) {
    const row = this.#requireGroup(groupId);
    if (!row.is_exclusive) {
      throw conflict('GROUP_NOT_EXCLUSIVE', '只能为 Sub2API 专属分组配置资格申请');
    }
    if (row.status !== 'active') {
      throw conflict('GROUP_INACTIVE', '只能为已启用的 Sub2API 分组配置资格申请');
    }
    return row;
  }

  #requireClaimable(rule) {
    if (!Boolean(rule.enabled) || rule.assignment_mode !== 'claim') {
      throw conflict('GROUP_CLAIM_DISABLED', '该资格活动当前不可领取');
    }
    const status = activityWindowStatus(rule.activity_starts_at, rule.activity_ends_at);
    if (status !== 'active') {
      throw conflict('GROUP_CLAIM_NOT_ACTIVE', status === 'upcoming' ? '资格活动尚未开始' : '资格活动已结束');
    }
    return this.#requireAssignableGroup(rule.group_id);
  }

  #ruleToApi(row) {
    const name = row.name || `${row.group_name || `分组 #${row.group_id}`} 资格申请`;
    return {
      id: String(row.id),
      name,
      group_id: Number(row.group_id),
      group_name: row.group_name || '',
      group: row.group_name ? groupToApi(row) : null,
      enabled: Boolean(row.enabled),
      assignment_mode: 'claim',
      activity_description: row.activity_description || '',
      activity_starts_at: row.activity_starts_at || null,
      activity_ends_at: row.activity_ends_at || null,
      revoke_at: row.revoke_at || null,
      concurrency_limit: row.concurrency_limit === null || row.concurrency_limit === undefined
        ? null
        : Number(row.concurrency_limit),
      revoke_when_ineligible: Boolean(row.revoke_when_ineligible),
      condition: conditionToApi(parseJson(row.condition_json)),
      managed_count: Number(row.managed_count || 0),
      preexisting_count: Number(row.preexisting_count || 0),
      last_executed_at: row.last_executed_at || null,
      last_execution: this.#lastExecution(row.id),
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  }

  #lastExecution(ruleId) {
    const row = this.db.prepare(`
      SELECT * FROM group_entitlement_runs WHERE rule_id = ? ORDER BY id DESC LIMIT 1
    `).get(ruleId);
    return row ? runToApi(row) : null;
  }
}

function normalizeRuleInput(input, existing = null) {
  const body = objectBody(input);
  if (body.assignment_mode !== undefined && body.assignment_mode !== 'claim') {
    throw badRequest('GROUP_RULE_MANUAL_ONLY', '分组资格仅支持用户手动申请');
  }
  const activityStartsAt = normalizeOptionalDate(
    body.activity_starts_at === undefined ? existing?.activity_starts_at : body.activity_starts_at,
    'activity_starts_at'
  );
  const activityEndsAt = normalizeOptionalDate(
    body.activity_ends_at === undefined ? existing?.activity_ends_at : body.activity_ends_at,
    'activity_ends_at'
  );
  const revokeAt = normalizeOptionalDate(
    body.revoke_at === undefined ? existing?.revoke_at : body.revoke_at,
    'revoke_at'
  );
  const concurrencyLimit = normalizeOptionalConcurrency(
    body.concurrency_limit === undefined ? existing?.concurrency_limit : body.concurrency_limit
  );
  if (activityStartsAt && activityEndsAt && activityStartsAt >= activityEndsAt) {
    throw badRequest('VALIDATION_ERROR', '活动结束时间必须晚于开始时间');
  }
  if (revokeAt && !activityEndsAt) {
    throw badRequest('VALIDATION_ERROR', '设置分组撤销时间前必须先设置活动结束时间');
  }
  if (revokeAt && activityEndsAt && revokeAt <= activityEndsAt) {
    throw badRequest('VALIDATION_ERROR', '分组撤销时间必须晚于活动结束时间');
  }
  return {
    name: requiredString(body.name ?? existing?.name, 'name', 120),
    group_id: body.group_id === undefined ? positiveId(existing?.group_id, 'group_id') : positiveId(body.group_id, 'group_id'),
    enabled: boolean(body.enabled ?? Boolean(existing?.enabled), 'enabled'),
    revoke_when_ineligible: false,
    assignment_mode: 'claim',
    activity_description: optionalString(
      body.activity_description === undefined ? existing?.activity_description : body.activity_description,
      'activity_description',
      500
    ),
    activity_starts_at: activityStartsAt,
    activity_ends_at: activityEndsAt,
    revoke_at: revokeAt,
    concurrency_limit: concurrencyLimit,
    condition: conditionFromApi(body.condition)
  };
}

function normalizeOptionalConcurrency(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > 100_000) {
    throw badRequest('VALIDATION_ERROR', 'concurrency_limit必须是 1 至 100000 之间的整数');
  }
  return parsed;
}

function normalizeOptionalDate(value, field) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw badRequest('VALIDATION_ERROR', `${field}必须是日期字符串`);
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest('VALIDATION_ERROR', `${field}不是有效日期`);
  return date.toISOString();
}

function activityWindowStatus(startsAt, endsAt, now = new Date()) {
  const time = now.getTime();
  if (startsAt && new Date(startsAt).getTime() > time) return 'upcoming';
  if (endsAt && new Date(endsAt).getTime() <= time) return 'ended';
  return 'active';
}

function claimResult(rule, decision, { granted, alreadyGranted }) {
  return {
    id: String(rule.id),
    type: 'group_entitlement',
    name: rule.name,
    description: rule.activity_description || '',
    group_id: Number(rule.group_id),
    group_name: rule.group_name || '',
    status: activityWindowStatus(rule.activity_starts_at, rule.activity_ends_at),
    starts_at: rule.activity_starts_at || null,
    ends_at: rule.activity_ends_at || null,
    eligible: decision.matched,
    granted,
    already_granted: alreadyGranted,
    facts: factsToApi(decision.facts),
    reasons: decision.reasons,
    condition: conditionToApi(rule.condition)
  };
}

function decide(rule, user, rechargeSummary, membership, forceRevoke) {
  const facts = makeUserFacts(user, rechargeSummary);
  const evaluation = evaluateRule(rule.condition, facts);
  const systemEligible = user.role === 'user' && user.status === 'active';
  const matched = !forceRevoke && systemEligible && evaluation.matched;
  const allowedGroups = normalizeAllowedGroups(parseJson(user.allowed_groups_json, []));
  const hasGroup = allowedGroups.includes(Number(rule.group_id));
  let action = 'none';
  if (matched && !hasGroup) action = 'grant';
  else if (matched && hasGroup && membership?.ownership === 'managed' && membership.status === 'active') action = 'keep_managed';
  else if (matched && hasGroup) action = 'keep_preexisting';
  else if (
    !matched && hasGroup && membership?.ownership === 'managed' && membership.status === 'active'
    && (forceRevoke || Boolean(rule.revoke_when_ineligible))
  ) action = 'revoke_managed';
  else if (!matched && hasGroup && membership?.ownership === 'managed' && membership.status === 'active') action = 'keep_managed';
  else if (!matched && hasGroup) action = 'keep_preexisting';
  const reasons = [];
  if (user.role !== 'user') reasons.push('管理员账号不能参与资格活动');
  if (user.status !== 'active') reasons.push('账号状态不可用');
  reasons.push(...evaluation.reasons);
  return { matched, action, has_group: hasGroup, allowed_groups: allowedGroups, facts, reasons };
}

function unionGroups(groups, groupId) {
  return normalizeAllowedGroups([...groups, Number(groupId)]);
}

function differenceGroup(groups, groupId) {
  return normalizeAllowedGroups(groups).filter((id) => id !== Number(groupId));
}

function emptySummary(rule, runId, mode) {
  return {
    run_id: runId === null ? null : String(runId),
    rule_id: String(rule.id),
    group_id: Number(rule.group_id),
    mode,
    scanned_count: 0,
    eligible_count: 0,
    grant_count: 0,
    revoke_count: 0,
    managed_count: 0,
    preexisting_count: 0,
    unchanged_count: 0,
    error_count: 0,
    errors: []
  };
}

function groupToApi(row) {
  const upstreamStatus = String(row.status ?? row.group_status ?? '');
  return {
    id: Number(row.group_id),
    name: row.group_name ?? row.name ?? '',
    multiplier: Number(row.rate_multiplier ?? row.group_rate_multiplier ?? 1),
    exclusive: Boolean(row.is_exclusive ?? row.group_is_exclusive),
    status: upstreamStatus === 'active' ? 'active' : 'inactive',
    ...(row.subscription_type ? { subscription_type: String(row.subscription_type) } : {}),
    // Keep the upstream aliases during the transition for older extension clients.
    rate_multiplier: Number(row.rate_multiplier ?? row.group_rate_multiplier ?? 1),
    is_exclusive: Boolean(row.is_exclusive ?? row.group_is_exclusive),
    ...(row.rule_id ? { rule_id: String(row.rule_id), rule_enabled: Boolean(row.rule_enabled) } : {})
  };
}

function ruleSelectSql(suffix) {
  const base = `
    SELECT r.*, g.name AS group_name, g.description AS group_description,
      g.platform AS group_platform, g.status AS group_status,
      g.is_exclusive AS group_is_exclusive,
      g.rate_multiplier AS group_rate_multiplier,
      SUM(CASE WHEN m.ownership = 'managed' AND m.status = 'active' THEN 1 ELSE 0 END) AS managed_count,
      SUM(CASE WHEN m.ownership = 'preexisting' AND m.status = 'active' THEN 1 ELSE 0 END) AS preexisting_count
    FROM group_entitlement_rules r
    LEFT JOIN synced_groups g ON g.group_id = r.group_id
    LEFT JOIN group_entitlement_memberships m ON m.rule_id = r.id
  `;
  return suffix.startsWith('WHERE')
    ? `${base} ${suffix} GROUP BY r.id, g.group_id`
    : `${base} GROUP BY r.id, g.group_id ${suffix}`;
}

function runToApi(row) {
  const result = parseJson(row.result_json, {});
  const stats = statsToApi({
    scanned_count: result.scanned_count,
    eligible_count: row.eligible_count,
    grant_count: row.grant_count,
    revoke_count: row.revoke_count,
    managed_count: row.managed_count,
    preexisting_count: row.preexisting_count,
    unchanged_count: row.unchanged_count,
    error_count: row.error_count
  });
  const errors = Array.isArray(result.errors) ? result.errors : [];
  return {
    id: String(row.id),
    rule_id: row.rule_id ? String(row.rule_id) : '',
    group_id: Number(row.group_id),
    rule_name: row.rule_name || '',
    group_name: row.group_name || '',
    mode: row.mode,
    status: row.status,
    ...stats,
    // Legacy aliases are retained for callers deployed before the web contract was finalized.
    grant_count: row.grant_count,
    revoke_count: row.revoke_count,
    error_count: row.error_count,
    errors,
    ...(Number(row.error_count) > 0 ? { error: `${Number(row.error_count)} 个用户处理失败` } : {}),
    started_at: row.started_at,
    completed_at: row.completed_at
  };
}

function statsToApi(summary) {
  const grantCount = Number(summary.grant_count || 0);
  const revokeCount = Number(summary.revoke_count || 0);
  const managedCount = Number(summary.managed_count || 0);
  const preexistingCount = Number(summary.preexisting_count || 0);
  const unchangedCount = Number(summary.unchanged_count || 0);
  const failedCount = Number(summary.error_count || 0);
  const derivedScanned = grantCount + revokeCount + managedCount
    + preexistingCount + unchangedCount + failedCount;
  const explicitScanned = Number(summary.scanned_count);
  return {
    scanned_count: Number.isFinite(explicitScanned) ? explicitScanned : derivedScanned,
    eligible_count: Number(summary.eligible_count || 0),
    managed_count: managedCount,
    preexisting_count: preexistingCount,
    granted_count: grantCount,
    revoked_count: revokeCount,
    unchanged_count: unchangedCount,
    failed_count: failedCount
  };
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
