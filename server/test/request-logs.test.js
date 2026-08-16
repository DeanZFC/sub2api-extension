import test from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../src/db.js';
import { RequestLogService } from '../src/request-logs.js';

test('调用日志保存安全字段并聚合重复限流请求', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const service = new RequestLogService(db, { apiLogRetentionDays: 30, rateLimitWindowMs: 60_000 });
  const base = {
    created_at: '2026-08-09T08:00:00.000Z',
    duration_ms: 12,
    ip_address: '203.0.113.8',
    user_id: 7,
    role: 'user',
    method: 'POST',
    path: '/api/activities/lottery/1/participate',
    route_pattern: '/api/activities/:type/:id/participate',
    user_agent: 'test-agent'
  };

  service.record({ ...base, request_id: 'normal-1', status_code: 200, result_code: 'OK', rate_limit_scope: 'participate' });
  service.record({ ...base, request_id: 'blocked-1', status_code: 429, result_code: 'RATE_LIMITED', rate_limit_scope: 'participate' });
  service.record({ ...base, request_id: 'blocked-2', status_code: 429, result_code: 'RATE_LIMITED', rate_limit_scope: 'participate' });
  service.flush();

  const all = service.list(new URLSearchParams());
  assert.equal(all.total, 2);
  const blocked = service.list(new URLSearchParams({ outcome: 'rate_limited' }));
  assert.equal(blocked.total, 1);
  assert.equal(blocked.items[0].request_count, 2);
  assert.equal(blocked.items[0].ip_address, '203.0.113.8');
  assert.equal(blocked.items[0].path, base.path);
});

test('调用日志按保留天数清理', (t) => {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  const service = new RequestLogService(db, { apiLogRetentionDays: 30 });
  service.record({
    request_id: 'old-1', created_at: '2026-01-01T00:00:00.000Z', duration_ms: 1,
    ip_address: '127.0.0.1', method: 'GET', path: '/api/session', route_pattern: '/api/session',
    status_code: 200, result_code: 'OK', user_agent: ''
  });
  assert.equal(service.cleanup(new Date('2026-03-01T00:00:00.000Z')), 1);
});
