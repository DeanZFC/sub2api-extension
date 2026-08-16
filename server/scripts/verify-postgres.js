import assert from 'node:assert/strict';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { openDatabase, transaction } from '../src/db.js';

const projectEnv = resolve(fileURLToPath(new URL('../../.env', import.meta.url)));
try {
  loadEnvFile(projectEnv);
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
}

if (!process.env.DATABASE_URL) throw new Error('缺少 DATABASE_URL');
const db = openDatabase(process.env.DATABASE_URL);
const marker = `postgres-verify-${Date.now()}`;

try {
  assert.equal(
    Number(db.prepare('SELECT COALESCE(MAX(version), 0) AS version FROM extension_schema_migrations').get().version),
    4
  );
  assert.equal(Number(db.prepare(`
    SELECT COUNT(*) AS count FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'group_entitlement_rules' AND column_name = 'revoke_at'
  `).get().count), 1);
  const modeConstraint = db.prepare(`
    SELECT pg_get_constraintdef(oid) AS definition
    FROM pg_constraint
    WHERE conrelid = 'group_entitlement_runs'::regclass
      AND conname = 'group_entitlement_runs_mode_check'
  `).get();
  assert.match(String(modeConstraint?.definition || ''), /expire/);

  assert.throws(() => transaction(db, () => {
    db.prepare(`
      INSERT INTO audit_events(actor_user_id, action, entity_type, entity_id, details_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(null, 'integration.rollback', 'database_test', marker, '{}', new Date().toISOString());
    throw new Error('force rollback');
  }), /force rollback/);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?').get(marker).count), 0);

  const inserted = db.prepare(`
    INSERT INTO audit_events(actor_user_id, action, entity_type, entity_id, details_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(null, 'integration.commit', 'database_test', marker, '{}', new Date().toISOString());
  assert.ok(Number(inserted.lastInsertRowid) > 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS count FROM audit_events WHERE entity_id = ?').get(marker).count), 1);
  assert.equal(db.prepare('DELETE FROM audit_events WHERE entity_id = ?').run(marker).changes, 1);

  console.log('PostgreSQL 事务、回滚、写入、读取和清理验证通过');
} finally {
  try { db.prepare('DELETE FROM audit_events WHERE entity_id = ?').run(marker); } catch { /* best-effort cleanup */ }
  db.close();
}
