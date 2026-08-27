import { isIP } from 'node:net';
import { AppError } from './errors.js';

const DEFAULT_WINDOW_MS = 60_000;

export class RateLimiter {
  constructor(config = {}) {
    this.enabled = config.rateLimitEnabled !== false;
    this.windowMs = positiveNumber(config.rateLimitWindowMs, DEFAULT_WINDOW_MS);
    this.limits = {
      entry: positiveNumber(config.rateLimitEntry, 20),
      participate: positiveNumber(config.rateLimitParticipate, 30),
      admin: positiveNumber(config.rateLimitAdmin, 120),
      write: positiveNumber(config.rateLimitWrite, 60),
      api: positiveNumber(config.rateLimitApi, 300)
    };
    this.trustProxy = Boolean(config.trustProxy);
    this.buckets = new Map();
    this.lastCleanupAt = 0;
  }

  assert(request, response, pathname) {
    const ip = clientIp(request, this.trustProxy);
    if (!this.enabled) return { ip, scope: '', limited: false };
    const scope = rateLimitScope(request.method, pathname);
    if (!scope) return { ip, scope: '', limited: false };

    const now = Date.now();
    this.#cleanup(now);
    const limit = this.limits[scope];
    const windowStartedAt = Math.floor(now / this.windowMs) * this.windowMs;
    const key = `${scope}:${ip}:${windowStartedAt}`;
    const bucket = this.buckets.get(key) || { count: 0, windowStartedAt };
    const resetSeconds = Math.max(1, Math.ceil((windowStartedAt + this.windowMs - now) / 1000));

    response.setHeader('RateLimit-Limit', String(limit));
    response.setHeader('RateLimit-Reset', String(resetSeconds));
    if (bucket.count >= limit) {
      response.setHeader('RateLimit-Remaining', '0');
      response.setHeader('Retry-After', String(resetSeconds));
      const error = new AppError(429, 'RATE_LIMITED', '请求过于频繁，请稍后再试', {
        scope,
        retry_after_seconds: resetSeconds
      });
      error.rateLimitScope = scope;
      throw error;
    }

    bucket.count += 1;
    this.buckets.set(key, bucket);
    response.setHeader('RateLimit-Remaining', String(Math.max(0, limit - bucket.count)));
    return { ip, scope, limited: false };
  }

  #cleanup(now) {
    if (now - this.lastCleanupAt < this.windowMs) return;
    this.lastCleanupAt = now;
    const expiresBefore = now - this.windowMs;
    for (const [key, bucket] of this.buckets) {
      if (bucket.windowStartedAt < expiresBefore) this.buckets.delete(key);
    }
  }
}

export function clientIp(request, trustProxy = false) {
  if (trustProxy) {
    const realIp = normalizedIp(singleHeader(request.headers?.['x-real-ip']));
    if (realIp) return realIp;
  }
  return normalizedIp(request.socket?.remoteAddress) || 'unknown';
}

export function rateLimitScope(methodValue, pathname) {
  const method = String(methodValue || 'GET').toUpperCase();
  if (pathname.startsWith('/entry/') || pathname.startsWith('/local-test/')) return 'entry';
  if ((method === 'POST' && /^\/api\/activities\/[^/]+\/[^/]+\/participate$/.test(pathname))
    || (method === 'DELETE' && /^\/api\/activities\/[^/]+\/[^/]+\/participation$/.test(pathname))) return 'participate';
  if (pathname.startsWith('/api/admin/')) return 'admin';
  if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) return 'write';
  if (pathname.startsWith('/api/')) return 'api';
  return '';
}

function singleHeader(value) {
  if (Array.isArray(value)) return value[0] || '';
  return typeof value === 'string' ? value.trim() : '';
}

function normalizedIp(value) {
  let candidate = String(value || '').trim();
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);
  const zoneIndex = candidate.indexOf('%');
  if (zoneIndex >= 0) candidate = candidate.slice(0, zoneIndex);
  return isIP(candidate) ? candidate : '';
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}
