import { AppError } from './errors.js';

export class Sub2ApiClient {
  constructor(config, fetchImpl = globalThis.fetch) {
    this.baseUrl = `${config.sub2apiBaseUrl}/api/v1`;
    this.adminApiKey = config.sub2apiAdminApiKey;
    this.timeoutMs = config.upstreamTimeoutMs;
    this.fetch = fetchImpl;
  }

  async authMe(token, { userAgent = '' } = {}) {
    return this.request('/auth/me', { token, userAgent });
  }

  async listUsers(page = 1, pageSize = 1000) {
    return this.request('/admin/users', {
      admin: true,
      query: {
        page,
        page_size: pageSize,
        include_subscriptions: 'false',
        sort_by: 'id',
        sort_order: 'asc'
      }
    });
  }

  async getUser(userId) {
    return this.request(`/admin/users/${encodeURIComponent(String(userId))}`, { admin: true });
  }

  async getUserBalanceHistory(userId, {
    page = 1,
    pageSize = 1,
    type = 'balance'
  } = {}) {
    return this.request(`/admin/users/${encodeURIComponent(String(userId))}/balance-history`, {
      admin: true,
      query: {
        page,
        page_size: pageSize,
        type
      }
    });
  }

  async updateUserAllowedGroups(userId, allowedGroups, concurrency = undefined) {
    const body = { allowed_groups: allowedGroups };
    if (concurrency !== undefined) body.concurrency = Number(concurrency);
    return this.request(`/admin/users/${encodeURIComponent(String(userId))}`, {
      admin: true,
      method: 'PUT',
      body
    });
  }

  async updateUserConcurrency(userId, concurrency) {
    return this.request(`/admin/users/${encodeURIComponent(String(userId))}`, {
      admin: true,
      method: 'PUT',
      body: { concurrency: Number(concurrency) }
    });
  }

  async listGroups(page = 1, pageSize = 1000) {
    return this.request('/admin/groups', {
      admin: true,
      query: {
        page,
        page_size: pageSize,
        sort_by: 'id',
        sort_order: 'asc'
      }
    });
  }

  async listRedeemCodes(type, page = 1, pageSize = 1000) {
    return this.request('/admin/redeem-codes', {
      admin: true,
      query: {
        page,
        page_size: pageSize,
        type,
        status: 'used',
        sort_by: 'used_at',
        sort_order: 'desc'
      }
    });
  }

  async createAndRedeem(payload, idempotencyKey) {
    return this.request('/admin/redeem-codes/create-and-redeem', {
      admin: true,
      method: 'POST',
      body: payload,
      idempotencyKey
    });
  }

  async request(path, options = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [key, value] of Object.entries(options.query || {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }
    const headers = { Accept: 'application/json' };
    if (options.admin) headers['x-api-key'] = this.adminApiKey;
    if (options.token) headers.Authorization = `Bearer ${options.token}`;
    if (options.userAgent) headers['User-Agent'] = options.userAgent.slice(0, 512);
    if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
    let body;
    if (options.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(options.body);
    }

    let response;
    try {
      response = await this.fetch(url, {
        method: options.method || 'GET',
        headers,
        body,
        redirect: 'error',
        signal: AbortSignal.timeout(this.timeoutMs)
      });
    } catch (error) {
      const reason = error?.name === 'TimeoutError' ? '请求超时' : '无法连接';
      throw new AppError(502, 'SUB2API_UNAVAILABLE', `Sub2API ${reason}`);
    }

    let envelope;
    try {
      envelope = await response.json();
    } catch {
      throw new AppError(502, 'SUB2API_INVALID_RESPONSE', 'Sub2API 返回了无效 JSON');
    }
    if (!response.ok || envelope?.code !== 0) {
      const upstreamCode = envelope?.code === undefined ? 'UNKNOWN' : String(envelope.code);
      const status = response.status === 401 ? 401 : response.status === 403 ? 403 : 502;
      const message = response.status === 401
        ? options.admin
          ? 'Sub2API 管理员 API Key 无效'
          : 'Sub2API 登录令牌无效或已过期'
        : `Sub2API 请求失败 (${upstreamCode})`;
      const error = new AppError(status, 'SUB2API_ERROR', message);
      error.upstreamStatus = response.status;
      throw error;
    }
    return envelope.data;
  }
}
