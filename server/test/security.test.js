import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionCookie, validateNextPath } from '../src/security.js';

test('跨站安全 Cookie 使用 Partitioned 支持第三方 iframe 会话', () => {
  const cookie = sessionCookie({
    sessionCookieName: 'session',
    sessionCookieSameSite: 'none',
    sessionCookieSecure: true,
    sessionTtlMs: 7_200_000
  }, 'token');

  assert.match(cookie, /SameSite=None/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /Partitioned/);
});

test('同站 Cookie 不添加 Partitioned', () => {
  const cookie = sessionCookie({
    sessionCookieName: 'session',
    sessionCookieSameSite: 'lax',
    sessionCookieSecure: true,
    sessionTtlMs: 7_200_000
  }, 'token');

  assert.match(cookie, /SameSite=Lax/);
  assert.doesNotMatch(cookie, /Partitioned/);
});

test('只允许站内 next 路径', () => {
  assert.equal(validateNextPath('/admin/lotteries?tab=active'), '/admin/lotteries?tab=active');
  assert.equal(validateNextPath('https://evil.example/x'), '/');
  assert.equal(validateNextPath('//evil.example/x'), '/');
  assert.equal(validateNextPath('/\\evil.example/x'), '/');
  assert.equal(validateNextPath('/%5cevil.example/x'), '/');
  assert.equal(validateNextPath('%2f%2fevil.example/x'), '/');
  assert.equal(validateNextPath(undefined, '/home'), '/home');
});
