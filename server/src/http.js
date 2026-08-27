import { randomUUID } from 'node:crypto';
import { AppError, asAppError, badRequest, forbidden } from './errors.js';
import { safeSecretEqual, secretHash, sessionCookie, setSecurityHeaders, validateNextPath } from './security.js';
import { requireAdmin } from './sessions.js';
import { upsertSyncedUser, getRechargeSummary } from './sync.js';
import { factsToApi, makeUserFacts } from './rules.js';
import { audit, nowIso, transaction } from './db.js';
import { tryServeStatic } from './static.js';
import { clientIp } from './rate-limiter.js';

export class Router {
  constructor({ config, sessionStore, syncService, rateLimiter, requestLogs }) {
    this.config = config;
    this.sessionStore = sessionStore;
    this.syncService = syncService;
    this.rateLimiter = rateLimiter;
    this.requestLogs = requestLogs;
    this.routes = [];
  }

  add(method, pattern, options, handler) {
    if (typeof options === 'function') {
      handler = options;
      options = {};
    }
    const keys = [];
    const source = pattern.split('/').map((part) => {
      if (part.startsWith(':')) {
        keys.push(part.slice(1));
        return '([^/]+)';
      }
      return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/');
    this.routes.push({ method, pattern, regex: new RegExp(`^${source}$`), keys, options, handler });
  }

  handler() {
    return async (request, response) => {
      const requestId = randomUUID();
      setSecurityHeaders(response, this.config);
      response.setHeader('X-Request-Id', requestId);
      let pathname = '/';
      let route = null;
      let session = null;
      let resultCode = 'OK';
      let rateLimitScope = '';
      const startedAt = Date.now();
      const createdAt = nowIso();
      const requestMeta = { user_id: null, role: '' };
      try {
        const url = new URL(request.url, 'http://extension.local');
        pathname = url.pathname;
        route = this.routes.find((candidate) => candidate.method === request.method && candidate.regex.test(pathname));
        if (!route) {
          if (await tryServeStatic(request, response, pathname, this.config.publicDir)) return;
          throw new AppError(404, 'NOT_FOUND', '接口不存在');
        }
        const match = route.regex.exec(pathname);
        const params = Object.fromEntries(route.keys.map((key, index) => [key, decodePathPart(match[index + 1])]));
        const rateLimit = this.rateLimiter?.assert(request, response, pathname);
        rateLimitScope = rateLimit?.scope || '';
        session = route.options.auth || route.options.admin
          ? this.sessionStore.getFromRequest(request)
          : null;
        if (session) {
          requestMeta.user_id = Number(session.user_id);
          requestMeta.role = String(session.role || '');
        }
        if (route.options.csrf) this.sessionStore.assertCsrf(request, session);
        if (route.options.admin) await this.#verifyCurrentAdmin(session);
        const body = route.options.body ? await readJsonBody(request, this.config.bodyLimitBytes) : undefined;
        await route.handler({ request, response, url, params, session, body, requestId, requestMeta });
      } catch (error) {
        const appError = asAppError(error);
        resultCode = appError.code;
        rateLimitScope ||= error?.rateLimitScope || '';
        if (!response.headersSent) {
          json(response, appError.status, {
            code: appError.code,
            message: appError.message,
            request_id: requestId,
            ...(appError.details ? { details: appError.details } : {})
          });
        } else {
          response.end();
        }
        if (appError.status >= 500) {
          // Deliberately log only method/path/code. URL queries, headers and bodies may contain tokens.
          console.error(JSON.stringify({ level: 'error', request_id: requestId, method: request.method, path: pathname, code: appError.code }));
        }
      } finally {
        if (shouldPersistRequest(pathname)) {
          try {
            this.requestLogs?.record({
              request_id: requestId,
              created_at: createdAt,
              duration_ms: Date.now() - startedAt,
              ip_address: clientIp(request, this.config.trustProxy),
              user_id: requestMeta.user_id,
              role: requestMeta.role,
              method: request.method,
              path: pathname,
              route_pattern: route?.pattern || '',
              status_code: response.statusCode,
              result_code: resultCode,
              rate_limit_scope: rateLimitScope,
              user_agent: request.headers['user-agent'] || ''
            });
          } catch (error) {
            console.error(JSON.stringify({ level: 'error', request_id: requestId, code: 'REQUEST_LOG_WRITE_FAILED' }));
          }
        }
      }
    };
  }

  async #verifyCurrentAdmin(session) {
    requireAdmin(session);
    const current = await this.syncService.refreshUser(session.user_id, { withRechargeHistory: false });
    if (current.role !== 'admin' || current.status !== 'active') {
      this.sessionStore.delete(session);
      throw forbidden('管理员权限已变更，请重新登录');
    }
  }
}

function decodePathPart(value) {
  try { return decodeURIComponent(value); } catch { throw badRequest('PATH_INVALID', '路径参数编码无效'); }
}

function shouldPersistRequest(pathname) {
  return pathname.startsWith('/api/')
    || pathname.startsWith('/entry/')
    || pathname.startsWith('/local-test/');
}

export function registerRoutes(router, services) {
  const {
    config, client, db, sessionStore, lotteries, outbox, groupEntitlements, activities, requestLogs
  } = services;

  router.add('GET', '/health', ({ response }) => {
    json(response, 200, { code: 0, message: 'success', data: { status: 'ok', time: nowIso() } });
  });

  router.add('GET', '/entry/activities', async ({ request, response, url, requestMeta }) => {
    const user = await authenticateEntryUser(client, request, url);
    requestMeta.user_id = Number(user.id);
    requestMeta.role = String(user.role || 'user');
    createEntrySession({
      db, sessionStore, config, response, url, user,
      action: 'session.activities_entry_created', forcedNextPath: '/'
    });
  });

  router.add('GET', '/entry/activities/admin', async ({ request, response, url, requestMeta }) => {
    const user = await authenticateEntryUser(client, request, url);
    requestMeta.user_id = Number(user.id);
    requestMeta.role = String(user.role || 'user');
    if (user.role !== 'admin' || user.status !== 'active') throw forbidden('仅管理员可进入管理中心');
    createEntrySession({
      db, sessionStore, config, response, url, user,
      action: 'session.activities_admin_entry_created', forcedNextPath: '/admin/lotteries'
    });
  });

  router.add('GET', '/local-test/entry', async ({ request, response, url, requestMeta }) => {
    if (!config.localTestEnabled) throw new AppError(404, 'NOT_FOUND', '接口不存在');
    if (!isLoopbackAddress(request.socket?.remoteAddress)) throw forbidden('本地测试入口只允许从本机访问');
    const providedSecret = url.searchParams.get('secret');
    const expectedHash = secretHash(config.localTestSecret, config.sessionSecret);
    if (!safeSecretEqual(providedSecret, expectedHash, config.sessionSecret)) {
      throw forbidden('本地测试密钥无效');
    }
    const userId = Number(url.searchParams.get('user_id'));
    if (!Number.isSafeInteger(userId) || userId <= 0) throw badRequest('USER_ID_INVALID', 'user_id 必须是正整数');
    const user = await client.getUser(userId);
    if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) !== userId) {
      throw new AppError(502, 'SUB2API_INVALID_USER', 'Sub2API 返回了无效用户');
    }
    requestMeta.user_id = Number(user.id);
    requestMeta.role = String(user.role || 'user');
    createEntrySession({ db, sessionStore, config, response, url, user, action: 'session.local_test_created' });
  });

  router.add('GET', '/api/session', { auth: true }, ({ response, session }) => {
    const csrfToken = sessionStore.csrfTokenForSession(session);
    const user = db.prepare('SELECT * FROM synced_users WHERE user_id = ?').get(session.user_id);
    const facts = user ? factsToApi(makeUserFacts(user, getRechargeSummary(db, session.user_id))) : undefined;
    response.setHeader('X-CSRF-Token', csrfToken);
    success(response, {
      authenticated: true,
      csrf_token: csrfToken,
      time_zone: config.activityTimeZone || 'Asia/Shanghai',
      user: {
        id: session.user_id,
        email: session.email,
        username: session.username,
        role: session.role,
        ...(facts || {})
      }
    });
  });

  router.add('POST', '/api/logout', { auth: true, csrf: true }, ({ response, session }) => {
    sessionStore.delete(session);
    response.setHeader('Set-Cookie', sessionCookie(config, '', 0));
    success(response, null);
  });

  router.add('GET', '/api/activities', { auth: true }, async ({ response, session }) => {
    success(response, await activities.listForUser(session.user_id));
  });
  router.add('GET', '/api/activities/:type/:id', { auth: true }, async ({ response, params, session }) => {
    success(response, await activities.getForUser(params.type, params.id, session.user_id));
  });
  router.add('POST', '/api/activities/:type/:id/participate', { auth: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await activities.participate(params.type, params.id, session.user_id));
  });
  router.add('DELETE', '/api/activities/:type/:id/participation', { auth: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await activities.withdraw(params.type, params.id, session.user_id));
  });

  router.add('GET', '/api/admin/group-grants/groups', { admin: true }, async ({ response }) => {
    success(response, await groupEntitlements.groups(true));
  });
  router.add('GET', '/api/admin/group-grants/rules', { admin: true }, ({ response }) => {
    success(response, groupEntitlements.listRules());
  });
  router.add('GET', '/api/admin/group-grants/rules/:id', { admin: true }, ({ response, params }) => {
    success(response, groupEntitlements.getRule(params.id));
  });
  router.add('POST', '/api/admin/group-grants/rules', { admin: true, csrf: true, body: true }, async ({ response, body, session }) => {
    const rule = await groupEntitlements.createRule(body, session.user_id);
    json(response, 201, { code: 0, message: 'success', data: rule });
  });
  router.add('PUT', '/api/admin/group-grants/rules/:id', { admin: true, csrf: true, body: true }, async ({ response, params, body, session }) => {
    const rule = await groupEntitlements.updateRule(params.id, body, session.user_id);
    success(response, rule);
  });
  router.add('DELETE', '/api/admin/group-grants/rules/:id', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await groupEntitlements.deleteRule(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/group-grants/rules/:id/revoke', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await groupEntitlements.revokeNow(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/group-grants/rules/:id/preview', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await groupEntitlements.preview(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/group-grants/rules/:id/execute', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await groupEntitlements.execute(params.id, session.user_id));
  });
  const groupGrantRuns = ({ response, url }) => {
    success(response, groupEntitlements.runs(url.searchParams.get('rule_id'), url.searchParams.get('limit')));
  };
  router.add('GET', '/api/admin/group-grants/runs', { admin: true }, groupGrantRuns);
  router.add('GET', '/api/admin/group-grants/executions', { admin: true }, groupGrantRuns);
  router.add('GET', '/api/admin/group-grants/history', { admin: true }, groupGrantRuns);

  router.add('GET', '/api/admin/checkins', { admin: true }, ({ response }) => {
    success(response, activities.listCheckins());
  });
  router.add('GET', '/api/admin/checkins/:id', { admin: true }, ({ response, params }) => {
    success(response, activities.getCheckin(params.id));
  });
  router.add('POST', '/api/admin/checkins', { admin: true, csrf: true, body: true }, ({ response, body, session }) => {
    json(response, 201, { code: 0, message: 'success', data: activities.createCheckin(body, session.user_id) });
  });
  router.add('PUT', '/api/admin/checkins/:id', { admin: true, csrf: true, body: true }, ({ response, params, body, session }) => {
    success(response, activities.updateCheckin(params.id, body, session.user_id));
  });
  router.add('DELETE', '/api/admin/checkins/:id', { admin: true, csrf: true }, ({ response, params, session }) => {
    activities.deleteCheckin(params.id, session.user_id);
    success(response, null);
  });

  router.add('GET', '/api/admin/lotteries', { admin: true }, ({ response }) => success(response, lotteries.list()));
  router.add('GET', '/api/admin/lotteries/:id', { admin: true }, ({ response, params }) => success(response, lotteries.get(params.id)));
  router.add('POST', '/api/admin/lotteries', { admin: true, csrf: true, body: true }, ({ response, body, session }) => {
    json(response, 201, { code: 0, message: 'success', data: lotteries.create(body, session.user_id) });
  });
  router.add('PUT', '/api/admin/lotteries/:id', { admin: true, csrf: true, body: true }, ({ response, params, body, session }) => {
    success(response, lotteries.update(params.id, body, session.user_id));
  });
  router.add('POST', '/api/admin/lotteries/:id/start', { admin: true, csrf: true }, ({ response, params, session }) => {
    success(response, lotteries.start(params.id, session.user_id));
  });
  router.add('DELETE', '/api/admin/lotteries/:id', { admin: true, csrf: true }, ({ response, params, session }) => {
    lotteries.delete(params.id, session.user_id);
    success(response, null);
  });

  router.add('PUT', '/api/admin/lotteries/:id/prizes', { admin: true, csrf: true, body: true }, ({ response, params, body, session }) => {
    success(response, lotteries.replacePrizes(params.id, body, session.user_id));
  });
  router.add('POST', '/api/admin/lotteries/:id/prizes', { admin: true, csrf: true, body: true }, ({ response, params, body, session }) => {
    json(response, 201, { code: 0, message: 'success', data: lotteries.addPrize(params.id, body, session.user_id) });
  });
  router.add('PUT', '/api/admin/prizes/:id', { admin: true, csrf: true, body: true }, ({ response, params, body, session }) => {
    success(response, lotteries.updatePrize(params.id, body, session.user_id));
  });
  router.add('DELETE', '/api/admin/prizes/:id', { admin: true, csrf: true }, ({ response, params, session }) => {
    lotteries.deletePrize(params.id, session.user_id);
    success(response, null);
  });

  router.add('POST', '/api/admin/lotteries/:id/candidates/generate', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await lotteries.generateSnapshot(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/lotteries/:id/candidates/lock', { admin: true, csrf: true }, async ({ response, params, session }) => {
    success(response, await lotteries.lock(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/lotteries/:id/draw', { admin: true, csrf: true }, async ({ request, response, params, session }) => {
    const value = await lotteries.drawNow(params.id, session.user_id, request.headers['idempotency-key']);
    setImmediate(() => outbox.processDue().catch(() => {}));
    success(response, value);
  });
  router.add('POST', '/api/admin/lotteries/:id/fulfill', { admin: true, csrf: true }, async ({ response, params }) => {
    await outbox.processLottery(params.id);
    success(response, lotteries.get(params.id));
  });
  router.add('GET', '/api/admin/lotteries/:id/outbox', { admin: true }, ({ response, params }) => {
    success(response, outbox.listForLottery(params.id));
  });
  router.add('POST', '/api/admin/outbox/:id/retry', { admin: true, csrf: true }, ({ response, params, session }) => {
    success(response, outbox.retry(params.id, session.user_id));
  });
  router.add('POST', '/api/admin/outbox/:id/complete', { admin: true, csrf: true, body: true }, ({ response, params, session, body }) => {
    success(response, outbox.completeManual(params.id, session.user_id, body?.external_ref));
  });
  router.add('GET', '/api/admin/request-logs', { admin: true }, ({ response, url }) => {
    success(response, requestLogs.list(url.searchParams));
  });
}

async function authenticateEntryUser(client, request, url) {
  const token = url.searchParams.get('token');
  if (!token || token.length > 8192) throw badRequest('TOKEN_REQUIRED', '缺少有效的 Sub2API 登录令牌');
  const user = await client.authMe(token, { userAgent: request.headers['user-agent'] || '' });
  if (!Number.isSafeInteger(Number(user?.id)) || Number(user.id) <= 0) {
    throw new AppError(502, 'SUB2API_INVALID_USER', 'Sub2API 返回了无效用户');
  }
  return user;
}

function createEntrySession({ db, sessionStore, config, response, url, user, action, forcedNextPath = null }) {
  transaction(db, () => {
    upsertSyncedUser(db, user);
    audit(db, Number(user.id), action, 'user', user.id, { role: String(user.role || 'user') });
  });
  const created = sessionStore.create(user);
  response.setHeader('Set-Cookie', sessionCookie(config, created.sessionToken));
  response.statusCode = 303;
  const nextPath = forcedNextPath || validateNextPath(url.searchParams.get('next'), '/');
  const redirect = new URL(nextPath, 'https://extension.invalid');
  const theme = url.searchParams.get('theme');
  if (theme === 'light' || theme === 'dark') redirect.searchParams.set('theme', theme);
  if (config.localTestEnabled && url.searchParams.get('ui_mode') === 'embedded') {
    redirect.hash = new URLSearchParams({ ext_session: created.sessionToken }).toString();
  }
  response.setHeader('Location', `${redirect.pathname}${redirect.search}${redirect.hash}`);
  response.end();
}

function isLoopbackAddress(value) {
  return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(String(value || ''));
}

export function success(response, data) {
  json(response, 200, { code: 0, message: 'success', data });
}

export function json(response, status, payload) {
  if (response.writableEnded) return;
  const body = JSON.stringify(payload);
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

export function readJsonBody(request, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let rejected = false;
    request.on('data', (chunk) => {
      length += chunk.length;
      if (length > limit) {
        rejected = true;
        chunks.length = 0;
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    request.on('end', () => {
      if (rejected) return reject(new AppError(413, 'BODY_TOO_LARGE', '请求体超出大小限制'));
      if (length === 0) return reject(badRequest('JSON_REQUIRED', '请求体不能为空'));
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(badRequest('JSON_INVALID', '请求体必须是有效 JSON'));
      }
    });
    request.on('error', reject);
  });
}
