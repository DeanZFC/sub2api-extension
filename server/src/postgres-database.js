import { Worker } from 'node:worker_threads';

const RESPONSE_BUFFER_BYTES = 64 * 1024 * 1024;
const DEFAULT_QUERY_TIMEOUT_MS = 30_000;
const IDENTITY_TABLES = new Set([
  'recharge_events',
  'activity_groups',
  'activity_items',
  'lotteries',
  'prizes',
  'candidate_snapshots',
  'draw_rounds',
  'winners',
  'outbox_jobs',
  'audit_events',
  'group_entitlement_rules',
  'group_entitlement_memberships',
  'group_entitlement_concurrency_overrides',
  'group_entitlement_runs',
  'checkin_campaigns',
  'checkin_records',
  'lottery_entries',
  'api_request_logs'
]);

export class PostgresSyncDatabase {
  constructor(databaseUrl, { connectionTimeoutMs = 15_000, queryTimeoutMs = DEFAULT_QUERY_TIMEOUT_MS } = {}) {
    this.dialect = 'postgres';
    this.queryTimeoutMs = queryTimeoutMs;
    this.closed = false;
    this.controlBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 2);
    this.responseBuffer = new SharedArrayBuffer(RESPONSE_BUFFER_BYTES);
    this.control = new Int32Array(this.controlBuffer);
    this.responseBytes = new Uint8Array(this.responseBuffer);
    this.decoder = new TextDecoder();
    this.worker = new Worker(new URL('./postgres-worker.js', import.meta.url), {
      execArgv: process.execArgv.filter((argument) => !argument.startsWith('--input-type')),
      workerData: {
        databaseUrl,
        connectionTimeoutMs,
        controlBuffer: this.controlBuffer,
        responseBuffer: this.responseBuffer
      }
    });
    try {
      this.#waitForResponse(Math.max(queryTimeoutMs, connectionTimeoutMs + 5_000));
    } catch (error) {
      this.closed = true;
      this.worker.terminate().catch(() => {});
      throw error;
    }
  }

  prepare(sql) {
    if (typeof sql !== 'string' || !sql.trim()) throw new TypeError('SQL 不能为空');
    return new PostgresSyncStatement(this, sql);
  }

  exec(sql) {
    const normalized = sql.trim().replace(/^BEGIN\s+IMMEDIATE\s*;?$/i, 'BEGIN');
    this.query(normalized, []);
  }

  query(sql, parameters) {
    if (this.closed) throw new Error('数据库连接已关闭');
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    this.worker.postMessage({ operation: 'query', sql, parameters });
    return this.#waitForResponse(this.queryTimeoutMs);
  }

  close() {
    if (this.closed) return;
    Atomics.store(this.control, 0, 0);
    Atomics.store(this.control, 1, 0);
    this.worker.postMessage({ operation: 'close' });
    try { this.#waitForResponse(5_000); } finally {
      this.closed = true;
      this.worker.terminate().catch(() => {});
    }
  }

  #waitForResponse(timeoutMs) {
    const waitResult = Atomics.wait(this.control, 0, 0, timeoutMs);
    if (waitResult === 'timed-out') {
      throw new Error(`PostgreSQL 操作超过 ${timeoutMs}ms`);
    }
    const length = Atomics.load(this.control, 1);
    const payload = JSON.parse(this.decoder.decode(this.responseBytes.subarray(0, length)));
    if (!payload.ok) {
      const error = new Error(payload.error?.message || 'PostgreSQL 操作失败');
      error.code = payload.error?.code || 'DATABASE_ERROR';
      if (payload.error?.constraint) error.constraint = payload.error.constraint;
      throw error;
    }
    return payload.result;
  }
}

class PostgresSyncStatement {
  constructor(db, sourceSql) {
    this.db = db;
    this.sourceSql = sourceSql;
  }

  get(...parameters) {
    return this.db.query(toPostgresSql(this.sourceSql), parameters).rows[0];
  }

  all(...parameters) {
    return this.db.query(toPostgresSql(this.sourceSql), parameters).rows;
  }

  run(...parameters) {
    const sql = withIdentityReturning(toPostgresSql(this.sourceSql));
    const result = this.db.query(sql, parameters);
    return {
      changes: result.rowCount,
      lastInsertRowid: result.rows[0]?.id ?? 0
    };
  }
}

export function toPostgresSql(sql) {
  let output = '';
  let parameterIndex = 0;
  let quote = null;
  let lineComment = false;
  let blockComment = false;

  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      output += character;
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      output += character;
      if (character === '*' && next === '/') {
        output += next;
        index += 1;
        blockComment = false;
      }
      continue;
    }
    if (quote) {
      output += character;
      if (character === quote) {
        if (next === quote) {
          output += next;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (character === '-' && next === '-') {
      output += `${character}${next}`;
      index += 1;
      lineComment = true;
      continue;
    }
    if (character === '/' && next === '*') {
      output += `${character}${next}`;
      index += 1;
      blockComment = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      output += character;
      continue;
    }
    if (character === '?') {
      parameterIndex += 1;
      output += `$${parameterIndex}`;
      continue;
    }
    output += character;
  }
  return output;
}

function withIdentityReturning(sql) {
  if (/\bRETURNING\b/i.test(sql)) return sql;
  const match = /^\s*INSERT\s+INTO\s+"?([a-z_][a-z0-9_]*)"?/i.exec(sql);
  if (!match || !IDENTITY_TABLES.has(match[1].toLowerCase())) return sql;
  const withoutTerminator = sql.replace(/;\s*$/, '');
  return `${withoutTerminator} RETURNING id`;
}
