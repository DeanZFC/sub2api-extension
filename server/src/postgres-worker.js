import { parentPort, workerData } from 'node:worker_threads';
import pg from 'pg';
import { POSTGRES_SCHEMA_MIGRATIONS, POSTGRES_SCHEMA_SQL, POSTGRES_SCHEMA_VERSION } from './postgres-schema.js';

const control = new Int32Array(workerData.controlBuffer);
const responseBytes = new Uint8Array(workerData.responseBuffer);
const encoder = new TextEncoder();
const client = new pg.Client({
  connectionString: workerData.databaseUrl,
  application_name: 'sub2api-extension',
  connectionTimeoutMillis: workerData.connectionTimeoutMs
});
// The parent may terminate this worker immediately after a graceful close.
// Keep the pg socket's late close event from becoming an uncaught worker error.
client.on('error', () => {});

function respond(payload, state = 1) {
  let encoded = encoder.encode(JSON.stringify(payload));
  if (encoded.length > responseBytes.length) {
    encoded = encoder.encode(JSON.stringify({
      ok: false,
      error: { code: 'DATABASE_RESPONSE_TOO_LARGE', message: '数据库查询结果超过进程通信上限' }
    }));
    state = 2;
  }
  responseBytes.fill(0, 0, Atomics.load(control, 1));
  responseBytes.set(encoded);
  Atomics.store(control, 1, encoded.length);
  Atomics.store(control, 0, state);
  Atomics.notify(control, 0);
}

function safeError(error) {
  return {
    code: String(error?.code || 'DATABASE_ERROR'),
    message: String(error?.message || 'PostgreSQL 操作失败').slice(0, 500),
    ...(error?.constraint ? { constraint: String(error.constraint).slice(0, 120) } : {})
  };
}

async function migrate() {
  await client.query(`
    CREATE TABLE IF NOT EXISTS extension_schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const result = await client.query('SELECT COALESCE(MAX(version), 0)::integer AS version FROM extension_schema_migrations');
  const current = Number(result.rows[0]?.version || 0);
  if (current > POSTGRES_SCHEMA_VERSION) {
    throw new Error(`数据库版本 ${current} 高于当前服务支持的版本 ${POSTGRES_SCHEMA_VERSION}`);
  }
  if (current === POSTGRES_SCHEMA_VERSION) return;

  await client.query('BEGIN');
  try {
    await client.query("SELECT pg_advisory_xact_lock(hashtext('sub2api-extension-schema'))");
    const locked = await client.query('SELECT COALESCE(MAX(version), 0)::integer AS version FROM extension_schema_migrations');
    let lockedVersion = Number(locked.rows[0]?.version || 0);
    if (lockedVersion === 0) {
      await client.query(POSTGRES_SCHEMA_SQL);
      await client.query('INSERT INTO extension_schema_migrations(version) VALUES ($1)', [POSTGRES_SCHEMA_VERSION]);
      lockedVersion = POSTGRES_SCHEMA_VERSION;
    }
    while (lockedVersion < POSTGRES_SCHEMA_VERSION) {
      const nextVersion = lockedVersion + 1;
      const sql = POSTGRES_SCHEMA_MIGRATIONS[nextVersion];
      if (!sql) throw new Error(`缺少 PostgreSQL 数据库版本 ${nextVersion} 的升级脚本`);
      await client.query(sql);
      await client.query('INSERT INTO extension_schema_migrations(version) VALUES ($1)', [nextVersion]);
      lockedVersion = nextVersion;
    }
    await client.query('COMMIT');
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* connection is already closed */ }
    throw error;
  }
}

async function initialize() {
  try {
    await client.connect();
    await migrate();
    respond({ ok: true, result: { ready: true } });
  } catch (error) {
    respond({ ok: false, error: safeError(error) }, 2);
  }
}

parentPort.on('message', async (request) => {
  try {
    if (request.operation === 'close') {
      await client.end();
      respond({ ok: true, result: null });
      return;
    }
    const result = await client.query(request.sql, request.parameters || []);
    respond({
      ok: true,
      result: {
        rows: Array.isArray(result.rows) ? result.rows : [],
        rowCount: Number(result.rowCount || 0)
      }
    });
  } catch (error) {
    respond({ ok: false, error: safeError(error) }, 2);
  }
});

await initialize();
