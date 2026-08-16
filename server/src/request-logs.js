import { nowIso, transaction } from './db.js';
import { badRequest } from './errors.js';

const METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

export class RequestLogService {
  constructor(db, config = {}) {
    this.db = db;
    this.retentionDays = positiveInteger(config.apiLogRetentionDays, 30);
    this.rateLimitWindowMs = positiveInteger(config.rateLimitWindowMs, 60_000);
    this.blocked = new Map();
    this.flushTimer = null;
  }

  record(entry) {
    const value = normalizeEntry(entry);
    if (value.status_code === 429) {
      this.#queueBlocked(value);
      return;
    }
    this.#insert(value, null, 1);
  }

  list(searchParams) {
    this.flush();
    const page = boundedInteger(searchParams.get('page'), 1, 1, 1_000_000, 'page');
    const pageSize = boundedInteger(searchParams.get('page_size'), 50, 1, 200, 'page_size');
    const filters = [];
    const parameters = [];
    const add = (sql, value) => {
      filters.push(sql);
      parameters.push(value);
    };
    const ip = optionalFilter(searchParams.get('ip'), 64, 'ip');
    const path = optionalFilter(searchParams.get('path'), 300, 'path');
    const resultCode = optionalFilter(searchParams.get('result_code'), 80, 'result_code');
    const method = optionalFilter(searchParams.get('method'), 10, 'method').toUpperCase();
    const userId = optionalPositiveInteger(searchParams.get('user_id'), 'user_id');
    const statusCode = optionalStatus(searchParams.get('status_code'));
    const outcome = optionalFilter(searchParams.get('outcome'), 20, 'outcome');
    const from = optionalDate(searchParams.get('from'), 'from');
    const to = optionalDate(searchParams.get('to'), 'to');

    if (ip) add('ip_address = ?', ip);
    if (path) add('path LIKE ?', `%${path}%`);
    if (resultCode) add('result_code = ?', resultCode);
    if (method) {
      if (!METHODS.has(method)) throw badRequest('LOG_FILTER_INVALID', 'method 筛选值无效');
      add('method = ?', method);
    }
    if (userId) add('user_id = ?', userId);
    if (statusCode) add('status_code = ?', statusCode);
    if (from) add('created_at >= ?', from);
    if (to) add('created_at <= ?', to);
    if (outcome === 'blocked') filters.push("status_code IN (401, 403, 429)");
    else if (outcome === 'error') filters.push('status_code >= 400');
    else if (outcome === 'rate_limited') filters.push('status_code = 429');
    else if (outcome && outcome !== 'all') throw badRequest('LOG_FILTER_INVALID', 'outcome 筛选值无效');

    const where = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const total = Number(this.db.prepare(`SELECT COUNT(*) AS count FROM api_request_logs ${where}`).get(...parameters).count);
    const rows = this.db.prepare(`
      SELECT * FROM api_request_logs ${where}
      ORDER BY id DESC LIMIT ? OFFSET ?
    `).all(...parameters, pageSize, (page - 1) * pageSize);
    return {
      items: rows.map(toApi),
      total,
      page,
      page_size: pageSize,
      pages: Math.max(1, Math.ceil(total / pageSize))
    };
  }

  cleanup(now = new Date()) {
    this.flush();
    const cutoff = new Date(now.getTime() - this.retentionDays * 86_400_000).toISOString();
    return this.db.prepare('DELETE FROM api_request_logs WHERE last_seen_at < ?').run(cutoff).changes;
  }

  flush() {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    if (this.blocked.size === 0) return;
    const values = [...this.blocked.values()];
    this.blocked.clear();
    transaction(this.db, () => {
      for (const item of values) this.#insert(item.entry, item.aggregationKey, item.count);
    });
  }

  close() {
    this.flush();
  }

  #queueBlocked(entry) {
    const windowStartedAt = Math.floor(new Date(entry.created_at).getTime() / this.rateLimitWindowMs) * this.rateLimitWindowMs;
    const aggregationKey = [windowStartedAt, entry.ip_address, entry.method, entry.route_pattern || entry.path].join('|');
    const existing = this.blocked.get(aggregationKey);
    if (existing) {
      existing.count += 1;
      existing.entry.last_seen_at = entry.last_seen_at;
      existing.entry.duration_ms = Math.max(existing.entry.duration_ms, entry.duration_ms);
    } else {
      this.blocked.set(aggregationKey, { aggregationKey, count: 1, entry });
    }
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        try { this.flush(); } catch { /* request logging must not terminate the server */ }
      }, 1_000);
      this.flushTimer.unref?.();
    }
  }

  #insert(entry, aggregationKey, requestCount) {
    this.db.prepare(`
      INSERT INTO api_request_logs(
        request_id, aggregation_key, created_at, last_seen_at, request_count,
        duration_ms, ip_address, user_id, role, method, path, route_pattern,
        status_code, result_code, rate_limit_scope, user_agent
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(aggregation_key) DO UPDATE SET
        last_seen_at = excluded.last_seen_at,
        request_count = api_request_logs.request_count + excluded.request_count,
        duration_ms = CASE WHEN excluded.duration_ms > api_request_logs.duration_ms
          THEN excluded.duration_ms ELSE api_request_logs.duration_ms END,
        user_id = COALESCE(excluded.user_id, api_request_logs.user_id),
        role = CASE WHEN excluded.role != '' THEN excluded.role ELSE api_request_logs.role END,
        result_code = excluded.result_code,
        rate_limit_scope = excluded.rate_limit_scope,
        user_agent = excluded.user_agent
    `).run(
      entry.request_id, aggregationKey, entry.created_at, entry.last_seen_at, requestCount,
      entry.duration_ms, entry.ip_address, entry.user_id, entry.role, entry.method,
      entry.path, entry.route_pattern, entry.status_code, entry.result_code,
      entry.rate_limit_scope, entry.user_agent
    );
  }
}

function normalizeEntry(entry) {
  const timestamp = entry.created_at || nowIso();
  return {
    request_id: String(entry.request_id || '').slice(0, 80),
    created_at: timestamp,
    last_seen_at: entry.last_seen_at || timestamp,
    duration_ms: Math.max(0, Math.min(86_400_000, Math.round(Number(entry.duration_ms) || 0))),
    ip_address: String(entry.ip_address || 'unknown').slice(0, 64),
    user_id: Number.isSafeInteger(Number(entry.user_id)) && Number(entry.user_id) > 0 ? Number(entry.user_id) : null,
    role: String(entry.role || '').slice(0, 32),
    method: String(entry.method || 'GET').toUpperCase().slice(0, 10),
    path: String(entry.path || '/').slice(0, 500),
    route_pattern: String(entry.route_pattern || '').slice(0, 500),
    status_code: Number.isSafeInteger(Number(entry.status_code)) ? Number(entry.status_code) : 500,
    result_code: String(entry.result_code || '').slice(0, 80),
    rate_limit_scope: String(entry.rate_limit_scope || '').slice(0, 32),
    user_agent: String(entry.user_agent || '').slice(0, 512)
  };
}

function toApi(row) {
  return {
    id: String(row.id),
    request_id: row.request_id,
    created_at: row.created_at,
    last_seen_at: row.last_seen_at,
    request_count: Number(row.request_count),
    duration_ms: Number(row.duration_ms),
    ip_address: row.ip_address,
    user_id: row.user_id === null ? null : Number(row.user_id),
    role: row.role,
    method: row.method,
    path: row.path,
    route_pattern: row.route_pattern,
    status_code: Number(row.status_code),
    result_code: row.result_code,
    rate_limit_scope: row.rate_limit_scope,
    user_agent: row.user_agent
  };
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function boundedInteger(value, fallback, min, max, field) {
  if (value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    throw badRequest('LOG_FILTER_INVALID', `${field} 筛选值无效`);
  }
  return parsed;
}

function optionalPositiveInteger(value, field) {
  if (value === null || value === '') return null;
  return boundedInteger(value, null, 1, Number.MAX_SAFE_INTEGER, field);
}

function optionalStatus(value) {
  if (value === null || value === '') return null;
  return boundedInteger(value, null, 100, 599, 'status_code');
}

function optionalFilter(value, maxLength, field) {
  if (value === null || value === '') return '';
  const text = String(value).trim();
  if ([...text].length > maxLength) throw badRequest('LOG_FILTER_INVALID', `${field} 筛选值过长`);
  return text;
}

function optionalDate(value, field) {
  if (value === null || value === '') return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw badRequest('LOG_FILTER_INVALID', `${field} 筛选值不是有效日期`);
  return date.toISOString();
}
