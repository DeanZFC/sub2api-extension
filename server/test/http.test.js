import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { createApplication } from '../src/app.js';
import { tryServeStatic } from '../src/static.js';

test('entry 命名空间不会回退到 SPA 页面', async () => {
  const request = { method: 'GET' };
  assert.equal(await tryServeStatic(request, {}, '/entry', '/unused'), false);
  assert.equal(await tryServeStatic(request, {}, '/entry/user', '/unused'), false);
  assert.equal(await tryServeStatic(request, {}, '/entry/admin', '/unused'), false);
  assert.equal(await tryServeStatic(request, {}, '/entry/unknown-page', '/unused'), false);
});

test('/entry/activities 交换干净会话，写请求需 CSRF 且管理权限实时复核', async (t) => {
  let currentRole = 'admin';
  const upstreamUser = () => ({
    id: 1,
    email: 'admin@example.com',
    username: 'admin',
    role: currentRole,
    status: 'active',
    balance: 100,
    total_recharged: 10,
    created_at: '2026-01-01T00:00:00Z'
  });
  const client = {
    async authMe(token) {
      assert.equal(token, 'one-time-jwt');
      return upstreamUser();
    },
    async getUser() { return upstreamUser(); },
    async listGroups() {
      return [{
        id: 5, name: '狂欢分组', status: 'active', is_exclusive: true,
        rate_multiplier: 0.01
      }];
    },
    async listUsers() { return { items: [upstreamUser()], pages: 1 }; },
    async listRedeemCodes() { return { items: [], pages: 1 }; },
    async createAndRedeem() { return { redeem_code: { id: 1 } }; }
  };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    syncIntervalMs: 300_000, outboxIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const entry = await invoke(app.handler, 'GET', '/entry/activities?token=one-time-jwt&next=%2F%2Fevil.example');
  assert.equal(entry.statusCode, 303);
  assert.equal(entry.getHeader('location'), '/');
  const cookie = entry.getHeader('set-cookie').split(';', 1)[0];
  assert.doesNotMatch(cookie, /one-time-jwt/);

  const sessionResponse = await invoke(app.handler, 'GET', '/api/session', { cookie });
  assert.equal(sessionResponse.statusCode, 200);
  const session = JSON.parse(sessionResponse.body).data;
  assert.equal(session.user.role, 'admin');
  assert.equal(session.time_zone, 'Asia/Shanghai');
  const csrf = session.csrf_token;

  const input = {
    name: '充值用户自动授权', group_id: 5, enabled: false, revoke_when_ineligible: false,
    condition: {
      type: 'group', operator: 'and', children: [
        { type: 'fact', fact: 'recharge_total', operator: 'gt', value: 0 }
      ]
    }
  };
  const withoutCsrf = await invoke(app.handler, 'POST', '/api/admin/group-grants/rules', { cookie }, input);
  assert.equal(withoutCsrf.statusCode, 403);

  const created = await invoke(app.handler, 'POST', '/api/admin/group-grants/rules', {
    cookie, 'x-csrf-token': csrf
  }, input);
  assert.equal(created.statusCode, 201);
  assert.equal(JSON.parse(created.body).data.name, input.name);

  const runs = await invoke(app.handler, 'GET', '/api/admin/group-grants/runs', { cookie });
  const executions = await invoke(app.handler, 'GET', '/api/admin/group-grants/executions', { cookie });
  assert.equal(executions.statusCode, 200);
  assert.deepEqual(JSON.parse(executions.body).data, JSON.parse(runs.body).data);

  currentRole = 'user';
  const revoked = await invoke(app.handler, 'GET', '/api/admin/group-grants/rules', { cookie });
  assert.equal(revoked.statusCode, 403);
});

test('本地测试入口校验回环地址和独立密钥后建立真实角色会话', async (t) => {
  const user = {
    id: 2, email: 'local@example.com', username: 'local', role: 'admin', status: 'active',
    balance: 0, total_recharged: 0, created_at: '2026-01-01T00:00:00Z'
  };
  const client = { async getUser(userId) { assert.equal(userId, 2); return user; } };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    outboxIntervalMs: 10_000, autoDrawIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768, localTestEnabled: true, localTestSecret: 'local-secret'.repeat(4)
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const denied = await invoke(app.handler, 'GET', '/local-test/entry?secret=wrong&user_id=2');
  assert.equal(denied.statusCode, 403);
  const accepted = await invoke(
    app.handler,
    'GET',
    `/local-test/entry?secret=${config.localTestSecret}&user_id=2&next=/admin/lotteries`
  );
  assert.equal(accepted.statusCode, 303);
  assert.equal(accepted.getHeader('location'), '/admin/lotteries');
  assert.match(accepted.getHeader('set-cookie'), /^ext_session=/);
});

test('活动中心与活动管理入口不依赖 next 且管理入口在建会话前校验角色', async (t) => {
  const users = {
    'user-jwt': {
      id: 2, email: 'user@example.com', username: 'user', role: 'user', status: 'active',
      balance: 0, total_recharged: 0, created_at: '2026-01-01T00:00:00Z'
    },
    'admin-jwt': {
      id: 1, email: 'admin@example.com', username: 'admin', role: 'admin', status: 'active',
      balance: 0, total_recharged: 0, created_at: '2026-01-01T00:00:00Z'
    }
  };
  const client = { async authMe(token) { return users[token]; } };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    outboxIntervalMs: 10_000, autoDrawIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768, localTestEnabled: false
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const removedEntry = await invoke(app.handler, 'GET', '/entry?token=admin-jwt');
  assert.equal(removedEntry.statusCode, 404);
  const removedUserEntry = await invoke(app.handler, 'GET', '/entry/user?token=user-jwt');
  assert.equal(removedUserEntry.statusCode, 404);
  const removedAdminEntry = await invoke(app.handler, 'GET', '/entry/admin?token=admin-jwt');
  assert.equal(removedAdminEntry.statusCode, 404);

  const userEntry = await invoke(app.handler, 'GET', '/entry/activities?token=user-jwt&next=/admin/lotteries');
  assert.equal(userEntry.statusCode, 303);
  assert.equal(userEntry.getHeader('location'), '/');

  const deniedAdmin = await invoke(app.handler, 'GET', '/entry/activities/admin?token=user-jwt');
  assert.equal(deniedAdmin.statusCode, 403);
  assert.equal(deniedAdmin.getHeader('set-cookie'), undefined);

  const adminEntry = await invoke(app.handler, 'GET', '/entry/activities/admin?token=admin-jwt&next=/');
  assert.equal(adminEntry.statusCode, 303);
  assert.equal(adminEntry.getHeader('location'), '/admin/lotteries');
});

test('本地内嵌模式通过 URL fragment 一次性交接会话', async (t) => {
  const user = {
    id: 2, email: 'user@example.com', username: 'user', role: 'user', status: 'active',
    balance: 0, total_recharged: 0, created_at: '2026-01-01T00:00:00Z'
  };
  const client = { async authMe() { return user; } };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    outboxIntervalMs: 10_000, autoDrawIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768, localTestEnabled: true
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const entry = await invoke(
    app.handler,
    'GET',
    '/entry/activities?token=user-jwt&theme=light&ui_mode=embedded'
  );
  assert.equal(entry.statusCode, 303);
  const location = new URL(entry.getHeader('location'), 'https://extension.invalid');
  assert.equal(location.pathname, '/');
  assert.equal(location.searchParams.get('theme'), 'light');
  const sessionToken = new URLSearchParams(location.hash.slice(1)).get('ext_session');
  assert.match(sessionToken, /^[A-Za-z0-9_-]{32,128}$/);

  const session = await invoke(app.handler, 'GET', '/api/session', {
    authorization: `Session ${sessionToken}`
  });
  assert.equal(session.statusCode, 200);
  assert.equal(JSON.parse(session.body).data.user.id, 2);
});

test('接口限流写入可追踪日志且不保存查询参数中的令牌', async (t) => {
  const user = {
    id: 2, email: 'user@example.com', username: 'user', role: 'user', status: 'active',
    balance: 0, total_recharged: 0, created_at: '2026-01-01T00:00:00Z'
  };
  const client = { async authMe() { return user; } };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    outboxIntervalMs: 10_000, autoDrawIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768, localTestEnabled: false, trustProxy: true,
    rateLimitWindowMs: 60_000, rateLimitApi: 2, rateLimitEntry: 20,
    rateLimitParticipate: 30, rateLimitAdmin: 120, rateLimitWrite: 60,
    apiLogRetentionDays: 30
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const entry = await invoke(app.handler, 'GET', '/entry/activities?token=secret-jwt', { 'x-real-ip': '203.0.113.11' });
  const cookie = entry.getHeader('set-cookie').split(';', 1)[0];
  const first = await invoke(app.handler, 'GET', '/api/session', { cookie, 'x-real-ip': '203.0.113.11' });
  const second = await invoke(app.handler, 'GET', '/api/session', { cookie, 'x-real-ip': '203.0.113.11' });
  const limited = await invoke(app.handler, 'GET', '/api/session', { cookie, 'x-real-ip': '203.0.113.11' });
  assert.equal(first.statusCode, 200);
  assert.equal(second.statusCode, 200);
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.getHeader('retry-after')) >= 1);

  app.services.requestLogs.flush();
  const rows = app.services.db.prepare('SELECT * FROM api_request_logs ORDER BY id').all();
  assert.equal(rows.length, 4);
  assert.equal(rows[0].path, '/entry/activities');
  assert.equal(rows.some((row) => JSON.stringify(row).includes('secret-jwt')), false);
  const blocked = rows.find((row) => row.status_code === 429);
  assert.equal(blocked.ip_address, '203.0.113.11');
  assert.equal(blocked.result_code, 'RATE_LIMITED');
});

test('抽奖退出接口要求登录和 CSRF，并且只能退出当前会话用户的参与记录', async (t) => {
  const user = {
    id: 2,
    email: 'participant@example.com',
    username: 'participant',
    role: 'user',
    status: 'active',
    balance: 10,
    total_recharged: 10,
    created_at: '2026-01-01T00:00:00Z'
  };
  const client = {
    async authMe(token) {
      assert.equal(token, 'participant-jwt');
      return user;
    },
    async getUser(userId) {
      assert.equal(userId, user.id);
      return user;
    },
    async getUserBalanceHistory(userId) {
      assert.equal(userId, user.id);
      return { total_recharged: 10, items: [], pages: 1 };
    }
  };
  const config = {
    host: '127.0.0.1', port: 0, dbPath: ':memory:',
    sessionSecret: 'x'.repeat(64), sessionCookieName: 'ext_session',
    sessionCookieSecure: false, sessionCookieSameSite: 'lax', sessionTtlMs: 3_600_000,
    outboxIntervalMs: 10_000, autoDrawIntervalMs: 10_000, rewardCodePrefix: 'S2EXT-',
    bodyLimitBytes: 32_768, localTestEnabled: false
  };
  const app = createApplication(config, { client });
  t.after(() => app.close());

  const lottery = app.services.lotteries.create({
    name: 'HTTP 退出测试',
    description: '',
    condition: { type: 'group', operator: 'and', children: [] },
    prizes: [{ name: '测试奖品', winner_count: 1, reward_type: 'manual', reward_value: 0, sort_order: 0 }]
  }, 99);
  app.services.lotteries.start(lottery.id, 99);

  const entry = await invoke(app.handler, 'GET', '/entry/activities?token=participant-jwt');
  const cookie = entry.getHeader('set-cookie').split(';', 1)[0];
  const session = await invoke(app.handler, 'GET', '/api/session', { cookie });
  const csrf = JSON.parse(session.body).data.csrf_token;

  const withoutCsrf = await invoke(app.handler, 'DELETE', `/api/activities/lottery/${lottery.id}/participation`, { cookie });
  assert.equal(withoutCsrf.statusCode, 403);

  const joined = await invoke(app.handler, 'POST', `/api/activities/lottery/${lottery.id}/participate`, {
    cookie, 'x-csrf-token': csrf
  });
  assert.equal(joined.statusCode, 200);
  assert.equal(JSON.parse(joined.body).data.participated, true);

  const withdrawn = await invoke(app.handler, 'DELETE', `/api/activities/lottery/${lottery.id}/participation`, {
    cookie, 'x-csrf-token': csrf
  });
  assert.equal(withdrawn.statusCode, 200);
  assert.equal(JSON.parse(withdrawn.body).data.withdrawn, true);
  assert.equal(app.services.db.prepare('SELECT COUNT(*) AS count FROM lottery_entries WHERE user_id = 2').get().count, 0);

  const unsupported = await invoke(app.handler, 'DELETE', '/api/activities/checkin/1/participation', {
    cookie, 'x-csrf-token': csrf
  });
  assert.equal(unsupported.statusCode, 400);
  assert.equal(JSON.parse(unsupported.body).code, 'ACTIVITY_WITHDRAW_UNSUPPORTED');
});

async function invoke(handler, method, url, headers = {}, body = undefined) {
  const encoded = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const request = Readable.from(encoded);
  request.method = method;
  request.url = url;
  request.headers = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  request.socket = { remoteAddress: '127.0.0.1' };
  const response = new MockResponse();
  await handler(request, response);
  return response;
}

class MockResponse {
  constructor() {
    this.statusCode = 200;
    this.headersSent = false;
    this.writableEnded = false;
    this.headers = new Map();
    this.body = '';
  }

  setHeader(name, value) { this.headers.set(name.toLowerCase(), value); }
  getHeader(name) { return this.headers.get(name.toLowerCase()); }
  end(value = '') {
    this.body += value ? String(value) : '';
    this.headersSent = true;
    this.writableEnded = true;
  }
}
