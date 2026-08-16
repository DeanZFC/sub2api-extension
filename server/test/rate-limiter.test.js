import test from 'node:test';
import assert from 'node:assert/strict';
import { RateLimiter, clientIp, rateLimitScope } from '../src/rate-limiter.js';

test('接口按类型限流并返回重试响应头', () => {
  const limiter = new RateLimiter({ rateLimitApi: 2, rateLimitWindowMs: 60_000 });
  const request = { method: 'GET', headers: {}, socket: { remoteAddress: '::ffff:127.0.0.1' } };
  const response = new HeaderResponse();
  limiter.assert(request, response, '/api/session');
  limiter.assert(request, response, '/api/session');
  assert.throws(
    () => limiter.assert(request, response, '/api/session'),
    (error) => error.status === 429 && error.code === 'RATE_LIMITED'
  );
  assert.equal(response.getHeader('ratelimit-remaining'), '0');
  assert.ok(Number(response.getHeader('retry-after')) >= 1);
});

test('仅显式信任代理时读取有效 X-Real-IP', () => {
  const request = {
    headers: { 'x-real-ip': '203.0.113.9' },
    socket: { remoteAddress: '127.0.0.1' }
  };
  assert.equal(clientIp(request, false), '127.0.0.1');
  assert.equal(clientIp(request, true), '203.0.113.9');
  assert.equal(rateLimitScope('POST', '/api/activities/lottery/1/participate'), 'participate');
  assert.equal(rateLimitScope('GET', '/api/admin/request-logs'), 'admin');
});

class HeaderResponse {
  constructor() { this.headers = new Map(); }
  setHeader(name, value) { this.headers.set(String(name).toLowerCase(), String(value)); }
  getHeader(name) { return this.headers.get(String(name).toLowerCase()); }
}
