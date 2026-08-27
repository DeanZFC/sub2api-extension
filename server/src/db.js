import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { PostgresSyncDatabase } from './postgres-database.js';

const SCHEMA_VERSION = 14;

export function openDatabase(path) {
  if (/^postgres(?:ql)?:\/\//i.test(path)) return new PostgresSyncDatabase(path);
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(path);
  if (path !== ':memory:') chmodSync(path, 0o600);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  migrate(db);
  return db;
}

function migrate(db) {
  const current = Number(db.prepare('PRAGMA user_version').get().user_version || 0);
  if (current > SCHEMA_VERSION) throw new Error(`数据库版本 ${current} 高于当前服务支持的版本 ${SCHEMA_VERSION}`);
  if (current < 1) {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE sessions (
        session_hash TEXT PRIMARY KEY,
        csrf_hash TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX sessions_expires_idx ON sessions(expires_at);

      CREATE TABLE synced_users (
        user_id INTEGER PRIMARY KEY,
        email TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT '',
        balance_cents TEXT NOT NULL DEFAULT '0',
        total_recharged_cents TEXT NOT NULL DEFAULT '0',
        created_at TEXT NOT NULL,
        upstream_updated_at TEXT,
        synced_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX synced_users_status_idx ON synced_users(status);

      CREATE TABLE recharge_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source_type TEXT NOT NULL,
        source_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        value_cents TEXT NOT NULL,
        used_at TEXT NOT NULL,
        code TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        synced_at TEXT NOT NULL,
        UNIQUE(source_type, source_id)
      ) STRICT;
      CREATE INDEX recharge_events_user_idx ON recharge_events(user_id);
      CREATE INDEX recharge_events_used_idx ON recharge_events(used_at);

      CREATE TABLE sync_cursors (
        source TEXT PRIMARY KEY,
        cursor_json TEXT NOT NULL DEFAULT '{}',
        last_started_at TEXT,
        last_completed_at TEXT,
        last_status TEXT NOT NULL DEFAULT 'never',
        last_error TEXT,
        item_count INTEGER NOT NULL DEFAULT 0
      ) STRICT;

      CREATE TABLE activity_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        action_url TEXT NOT NULL DEFAULT '',
        action_label TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL DEFAULT 'inactive',
        visibility_rule_json TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX activity_groups_visible_idx ON activity_groups(status, sort_order, id);

      CREATE TABLE lotteries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'not_started',
        rule_json TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        candidates_generated_at TEXT,
        locked_at TEXT,
        drawn_at TEXT
      ) STRICT;
      CREATE INDEX lotteries_status_idx ON lotteries(status, id);

      CREATE TABLE prizes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_id INTEGER NOT NULL REFERENCES lotteries(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        winner_count INTEGER NOT NULL,
        reward_type TEXT NOT NULL,
        reward_value TEXT NOT NULL DEFAULT '0',
        group_id INTEGER,
        validity_days INTEGER,
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX prizes_lottery_idx ON prizes(lottery_id, sort_order, id);

      CREATE TABLE candidate_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_id INTEGER NOT NULL REFERENCES lotteries(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        email TEXT NOT NULL DEFAULT '',
        username TEXT NOT NULL DEFAULT '',
        eligible INTEGER NOT NULL CHECK (eligible IN (0, 1)),
        facts_json TEXT NOT NULL,
        explanation_json TEXT NOT NULL,
        generated_at TEXT NOT NULL,
        locked_at TEXT,
        UNIQUE(lottery_id, user_id)
      ) STRICT;
      CREATE INDEX candidate_snapshots_pool_idx ON candidate_snapshots(lottery_id, eligible, user_id);

      CREATE TABLE draw_rounds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_id INTEGER NOT NULL REFERENCES lotteries(id) ON DELETE RESTRICT,
        idempotency_key TEXT NOT NULL,
        status TEXT NOT NULL,
        candidate_count INTEGER NOT NULL,
        winner_count INTEGER NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        UNIQUE(lottery_id, idempotency_key)
      ) STRICT;

      CREATE TABLE winners (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        draw_round_id INTEGER NOT NULL REFERENCES draw_rounds(id) ON DELETE RESTRICT,
        lottery_id INTEGER NOT NULL REFERENCES lotteries(id) ON DELETE RESTRICT,
        prize_id INTEGER NOT NULL REFERENCES prizes(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL,
        reward_status TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(draw_round_id, user_id)
      ) STRICT;
      CREATE INDEX winners_lottery_idx ON winners(lottery_id, id);

      CREATE TABLE outbox_jobs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        winner_id INTEGER NOT NULL UNIQUE REFERENCES winners(id) ON DELETE RESTRICT,
        job_type TEXT NOT NULL,
        status TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT,
        last_error TEXT,
        external_ref TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX outbox_pending_idx ON outbox_jobs(status, next_attempt_at, id);

      CREATE TABLE audit_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        details_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX audit_events_entity_idx ON audit_events(entity_type, entity_id, id);

      PRAGMA user_version = 1;
      COMMIT;
    `);
  }
  if (current < 2) {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE activity_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL REFERENCES activity_groups(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        action_url TEXT NOT NULL,
        action_label TEXT NOT NULL DEFAULT '',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX activity_items_group_idx ON activity_items(group_id, enabled, sort_order, id);

      INSERT INTO activity_items(
        group_id, name, description, action_url, action_label, enabled,
        sort_order, created_at, updated_at
      )
      SELECT id, name, '', action_url, action_label, 1, 0, created_at, updated_at
      FROM activity_groups WHERE action_url != '';

      PRAGMA user_version = 2;
      COMMIT;
    `);
  }
  if (current < 3) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE synced_users ADD COLUMN allowed_groups_json TEXT NOT NULL DEFAULT '[]';

      CREATE TABLE synced_groups (
        group_id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        platform TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        is_exclusive INTEGER NOT NULL DEFAULT 0 CHECK (is_exclusive IN (0, 1)),
        upstream_updated_at TEXT,
        synced_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX synced_groups_status_idx ON synced_groups(status, name);

      CREATE TABLE group_entitlement_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL UNIQUE,
        enabled INTEGER NOT NULL DEFAULT 0 CHECK (enabled IN (0, 1)),
        condition_json TEXT NOT NULL,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_executed_at TEXT
      ) STRICT;

      CREATE TABLE group_entitlement_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        rule_id INTEGER REFERENCES group_entitlement_rules(id) ON DELETE SET NULL,
        ownership TEXT NOT NULL CHECK (ownership IN ('managed', 'preexisting')),
        status TEXT NOT NULL CHECK (status IN ('active', 'revoked')),
        first_seen_at TEXT NOT NULL,
        granted_at TEXT,
        revoked_at TEXT,
        last_seen_at TEXT NOT NULL,
        last_action TEXT NOT NULL DEFAULT '',
        UNIQUE(group_id, user_id)
      ) STRICT;
      CREATE INDEX group_memberships_rule_idx ON group_entitlement_memberships(rule_id, status, ownership);
      CREATE INDEX group_memberships_user_idx ON group_entitlement_memberships(user_id, status);

      CREATE TABLE group_entitlement_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES group_entitlement_rules(id) ON DELETE SET NULL,
        group_id INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('preview', 'execute', 'revoke', 'expire')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        eligible_count INTEGER NOT NULL DEFAULT 0,
        grant_count INTEGER NOT NULL DEFAULT 0,
        revoke_count INTEGER NOT NULL DEFAULT 0,
        managed_count INTEGER NOT NULL DEFAULT 0,
        preexisting_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        actor_user_id INTEGER,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      CREATE INDEX group_runs_rule_idx ON group_entitlement_runs(rule_id, id DESC);

      PRAGMA user_version = 3;
      COMMIT;
    `);
  }
  if (current < 4) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE synced_groups ADD COLUMN rate_multiplier REAL NOT NULL DEFAULT 1;
      ALTER TABLE group_entitlement_rules ADD COLUMN name TEXT NOT NULL DEFAULT '';
      ALTER TABLE group_entitlement_rules ADD COLUMN revoke_when_ineligible INTEGER NOT NULL DEFAULT 1
        CHECK (revoke_when_ineligible IN (0, 1));
      ALTER TABLE group_entitlement_runs ADD COLUMN rule_name TEXT NOT NULL DEFAULT '';
      ALTER TABLE group_entitlement_runs ADD COLUMN group_name TEXT NOT NULL DEFAULT '';

      PRAGMA user_version = 4;
      COMMIT;
    `);
  }
  if (current < 5) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE lotteries ADD COLUMN published INTEGER NOT NULL DEFAULT 0
        CHECK (published IN (0, 1));
      ALTER TABLE lotteries ADD COLUMN starts_at TEXT;
      ALTER TABLE lotteries ADD COLUMN ends_at TEXT;

      ALTER TABLE group_entitlement_rules ADD COLUMN assignment_mode TEXT NOT NULL DEFAULT 'automatic'
        CHECK (assignment_mode IN ('automatic', 'claim'));
      ALTER TABLE group_entitlement_rules ADD COLUMN activity_description TEXT NOT NULL DEFAULT '';
      ALTER TABLE group_entitlement_rules ADD COLUMN activity_starts_at TEXT;
      ALTER TABLE group_entitlement_rules ADD COLUMN activity_ends_at TEXT;

      CREATE TABLE checkin_campaigns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        published INTEGER NOT NULL DEFAULT 0 CHECK (published IN (0, 1)),
        condition_json TEXT NOT NULL,
        reward_type TEXT NOT NULL DEFAULT 'none' CHECK (reward_type IN ('none', 'balance')),
        reward_value TEXT NOT NULL DEFAULT '0',
        starts_at TEXT,
        ends_at TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT;
      CREATE INDEX checkin_campaigns_visible_idx ON checkin_campaigns(published, starts_at, ends_at, id);

      CREATE TABLE checkin_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        campaign_id INTEGER NOT NULL REFERENCES checkin_campaigns(id) ON DELETE RESTRICT,
        user_id INTEGER NOT NULL,
        local_date TEXT NOT NULL,
        streak_days INTEGER NOT NULL DEFAULT 1,
        facts_json TEXT NOT NULL DEFAULT '{}',
        reward_status TEXT NOT NULL DEFAULT 'none'
          CHECK (reward_status IN ('none', 'pending', 'succeeded', 'failed')),
        reward_external_ref TEXT,
        reward_error TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(campaign_id, user_id, local_date)
      ) STRICT;
      CREATE INDEX checkin_records_user_idx ON checkin_records(user_id, campaign_id, local_date DESC);

      PRAGMA user_version = 5;
      COMMIT;
    `);
  }
  if (current < 6) {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE lottery_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lottery_id INTEGER NOT NULL REFERENCES lotteries(id) ON DELETE CASCADE,
        user_id INTEGER NOT NULL,
        facts_json TEXT NOT NULL,
        explanation_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(lottery_id, user_id)
      ) STRICT;
      CREATE INDEX lottery_entries_lottery_idx ON lottery_entries(lottery_id, user_id);

      PRAGMA user_version = 6;
      COMMIT;
    `);
  }
  if (current < 7) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE lotteries ADD COLUMN auto_draw_at TEXT;
      ALTER TABLE lotteries ADD COLUMN auto_draw_attempted_at TEXT;
      ALTER TABLE lotteries ADD COLUMN auto_draw_error TEXT;
      CREATE INDEX lotteries_auto_draw_idx
        ON lotteries(status, auto_draw_at, auto_draw_attempted_at, id);

      PRAGMA user_version = 7;
      COMMIT;
    `);
  }
  if (current < 8) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE synced_groups ADD COLUMN subscription_type TEXT NOT NULL DEFAULT '';

      PRAGMA user_version = 8;
      COMMIT;
    `);
  }
  if (current < 9) {
    db.exec(`
      BEGIN IMMEDIATE;

      UPDATE group_entitlement_rules
      SET assignment_mode = 'claim', revoke_when_ineligible = 0
      WHERE assignment_mode != 'claim' OR revoke_when_ineligible != 0;

      PRAGMA user_version = 9;
      COMMIT;
    `);
  }
  if (current < 10) {
    db.exec(`
      BEGIN IMMEDIATE;

      UPDATE lotteries
      SET status = CASE WHEN published = 1 THEN 'active' ELSE 'not_started' END
      WHERE status = 'draft';

      PRAGMA user_version = 10;
      COMMIT;
    `);
  }
  if (current < 11) {
    db.exec(`
      BEGIN IMMEDIATE;

      CREATE TABLE IF NOT EXISTS api_request_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        request_id TEXT NOT NULL,
        aggregation_key TEXT UNIQUE,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        request_count INTEGER NOT NULL DEFAULT 1,
        duration_ms INTEGER NOT NULL DEFAULT 0,
        ip_address TEXT NOT NULL DEFAULT '',
        user_id INTEGER,
        role TEXT NOT NULL DEFAULT '',
        method TEXT NOT NULL,
        path TEXT NOT NULL,
        route_pattern TEXT NOT NULL DEFAULT '',
        status_code INTEGER NOT NULL,
        result_code TEXT NOT NULL DEFAULT '',
        rate_limit_scope TEXT NOT NULL DEFAULT '',
        user_agent TEXT NOT NULL DEFAULT ''
      ) STRICT;
      CREATE INDEX IF NOT EXISTS api_request_logs_created_idx ON api_request_logs(created_at DESC, id DESC);
      CREATE INDEX IF NOT EXISTS api_request_logs_ip_idx ON api_request_logs(ip_address, id DESC);
      CREATE INDEX IF NOT EXISTS api_request_logs_user_idx ON api_request_logs(user_id, id DESC);
      CREATE INDEX IF NOT EXISTS api_request_logs_status_idx ON api_request_logs(status_code, id DESC);

      PRAGMA user_version = 11;
      COMMIT;
    `);
  }
  if (current < 12) {
    db.exec(`
      BEGIN IMMEDIATE;

      ALTER TABLE group_entitlement_runs RENAME TO group_entitlement_runs_v11;
      CREATE TABLE group_entitlement_runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        rule_id INTEGER REFERENCES group_entitlement_rules(id) ON DELETE SET NULL,
        group_id INTEGER NOT NULL,
        rule_name TEXT NOT NULL DEFAULT '',
        group_name TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL CHECK (mode IN ('preview', 'execute', 'revoke', 'expire')),
        status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'partial', 'failed')),
        eligible_count INTEGER NOT NULL DEFAULT 0,
        grant_count INTEGER NOT NULL DEFAULT 0,
        revoke_count INTEGER NOT NULL DEFAULT 0,
        managed_count INTEGER NOT NULL DEFAULT 0,
        preexisting_count INTEGER NOT NULL DEFAULT 0,
        unchanged_count INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        result_json TEXT NOT NULL DEFAULT '{}',
        actor_user_id INTEGER,
        started_at TEXT NOT NULL,
        completed_at TEXT
      ) STRICT;
      INSERT INTO group_entitlement_runs(
        id, rule_id, group_id, rule_name, group_name, mode, status,
        eligible_count, grant_count, revoke_count, managed_count,
        preexisting_count, unchanged_count, error_count, result_json,
        actor_user_id, started_at, completed_at
      )
      SELECT
        id, rule_id, group_id, rule_name, group_name, mode, status,
        eligible_count, grant_count, revoke_count, managed_count,
        preexisting_count, unchanged_count, error_count, result_json,
        actor_user_id, started_at, completed_at
      FROM group_entitlement_runs_v11;
      DROP TABLE group_entitlement_runs_v11;
      CREATE INDEX group_runs_rule_idx ON group_entitlement_runs(rule_id, id DESC);

      PRAGMA user_version = 12;
      COMMIT;
    `);
  }
  if (current < 13) {
    const hasRevokeAt = db.prepare(`
      SELECT 1 AS present FROM pragma_table_info('group_entitlement_rules') WHERE name = 'revoke_at'
    `).get();
    db.exec(hasRevokeAt ? `
      PRAGMA user_version = 13;
    ` : `
      BEGIN IMMEDIATE;
      ALTER TABLE group_entitlement_rules ADD COLUMN revoke_at TEXT;
      PRAGMA user_version = 13;
      COMMIT;
    `);
  }
  if (current < 14) {
    const hasColumn = (table, column) => Boolean(db.prepare(`
      SELECT 1 FROM pragma_table_info(?) WHERE name = ?
    `).get(table, column));
    const hasTable = (table) => Boolean(db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(table));
    const statements = [];
    if (!hasColumn('synced_users', 'concurrency')) {
      statements.push('ALTER TABLE synced_users ADD COLUMN concurrency INTEGER NOT NULL DEFAULT 0;');
    }
    if (!hasColumn('group_entitlement_rules', 'concurrency_limit')) {
      statements.push('ALTER TABLE group_entitlement_rules ADD COLUMN concurrency_limit INTEGER;');
    }
    if (!hasTable('group_entitlement_concurrency_overrides')) {
      statements.push(`
        CREATE TABLE group_entitlement_concurrency_overrides (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          rule_id INTEGER NOT NULL REFERENCES group_entitlement_rules(id) ON DELETE CASCADE,
          group_id INTEGER NOT NULL,
          user_id INTEGER NOT NULL,
          original_concurrency INTEGER NOT NULL CHECK (original_concurrency >= 0),
          applied_concurrency INTEGER NOT NULL CHECK (applied_concurrency >= 0),
          status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'failed', 'restored')),
          created_at TEXT NOT NULL,
          applied_at TEXT,
          restored_at TEXT,
          last_error TEXT,
          UNIQUE(rule_id, user_id)
        ) STRICT;
      `);
    }
    statements.push(`
      CREATE INDEX IF NOT EXISTS concurrency_overrides_user_idx
        ON group_entitlement_concurrency_overrides(user_id, status, id DESC);
      CREATE INDEX IF NOT EXISTS concurrency_overrides_rule_idx
        ON group_entitlement_concurrency_overrides(rule_id, status, user_id);
    `);
    db.exec(`BEGIN IMMEDIATE;${statements.join('\n')}\nPRAGMA user_version = 14; COMMIT;`);
  }
}

export function transaction(db, callback) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = callback();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw error;
  }
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined || value === '') return fallback;
  try { return JSON.parse(value); } catch { return fallback; }
}

export function nowIso(now = new Date()) {
  return now.toISOString();
}

export function audit(db, actorUserId, action, entityType, entityId, details = {}) {
  db.prepare(`
    INSERT INTO audit_events(actor_user_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(actorUserId ?? null, action, entityType, String(entityId), JSON.stringify(details), nowIso());
}
