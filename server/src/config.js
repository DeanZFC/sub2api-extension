import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { badRequest } from './errors.js';

const DEFAULT_PUBLIC_DIR = fileURLToPath(new URL('../../web/dist', import.meta.url));

function envBoolean(value, fallback) {
  if (value === undefined || value === '') return fallback;
  if (['1', 'true', 'yes', 'on'].includes(value.toLowerCase())) return true;
  if (['0', 'false', 'no', 'off'].includes(value.toLowerCase())) return false;
  throw new Error(`无效布尔配置: ${value}`);
}

function envPositiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

export function parseDuration(value, fallbackMs) {
  if (value === undefined || value === '') return fallbackMs;
  if (/^\d+$/.test(value)) return Number(value);
  const match = /^(\d+)(ms|s|m|h|d)$/.exec(value);
  if (!match) throw new Error(`无效时长: ${value}`);
  const multiplier = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
  return Number(match[1]) * multiplier;
}

function cleanBaseUrl(value) {
  if (!value) return '';
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('SUB2API_BASE_URL 必须使用 http/https');
  parsed.username = '';
  parsed.password = '';
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '').replace(/\/api\/v1$/, '');
}

function cleanDatabaseUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('DATABASE_URL 必须是有效的 PostgreSQL 连接地址'); }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol) || !parsed.hostname || parsed.pathname.length < 2) {
    throw new Error('DATABASE_URL 必须使用 postgresql:// 并包含主机和数据库名');
  }
  return value;
}

function frameAncestors(value, sub2apiBaseUrl) {
  const fallback = sub2apiBaseUrl ? new URL(sub2apiBaseUrl).origin : "'self'";
  const sources = String(value || fallback).trim().split(/\s+/).filter(Boolean);
  if (sources.length === 0) throw new Error('FRAME_ANCESTORS 不能为空');
  for (const source of sources) {
    if (["'self'", "'none'"].includes(source)) continue;
    let parsed;
    try { parsed = new URL(source); } catch { throw new Error(`FRAME_ANCESTORS 包含无效来源: ${source}`); }
    if (!['http:', 'https:'].includes(parsed.protocol) || source !== parsed.origin) {
      throw new Error(`FRAME_ANCESTORS 只允许完整的 http/https 来源: ${source}`);
    }
  }
  if (sources.includes("'none'") && sources.length > 1) {
    throw new Error("FRAME_ANCESTORS 使用 'none' 时不能配置其他来源");
  }
  return sources.join(' ');
}

export function loadConfig(env = process.env) {
  const sameSite = (env.SESSION_COOKIE_SAME_SITE || 'Lax').toLowerCase();
  if (!['lax', 'strict', 'none'].includes(sameSite)) {
    throw new Error('SESSION_COOKIE_SAME_SITE 只能是 Lax、Strict 或 None');
  }
  const cookieSecure = envBoolean(env.SESSION_COOKIE_SECURE, true);
  if (sameSite === 'none' && !cookieSecure) {
    throw new Error('SameSite=None 必须同时启用 Secure Cookie');
  }
  const dbPath = env.DB_PATH || './data/extension.sqlite';
  const databaseUrl = cleanDatabaseUrl(env.DATABASE_URL || '');
  const sub2apiBaseUrl = cleanBaseUrl(env.SUB2API_BASE_URL || '');
  return {
    host: env.HOST || '0.0.0.0',
    port: Number(env.PORT || 18084),
    sub2apiBaseUrl,
    sub2apiAdminApiKey: env.SUB2API_ADMIN_API_KEY || '',
    sessionSecret: env.SESSION_SECRET || '',
    sessionCookieName: env.SESSION_COOKIE_NAME || 'sub2api_ext_session',
    sessionCookieSecure: cookieSecure,
    sessionCookieSameSite: sameSite,
    sessionTtlMs: parseDuration(env.SESSION_TTL || '2h', 7_200_000),
    localTestEnabled: envBoolean(env.LOCAL_TEST_ENABLED, false),
    localTestSecret: env.LOCAL_TEST_SECRET || '',
    trustProxy: envBoolean(env.TRUST_PROXY, false),
    rateLimitEnabled: envBoolean(env.RATE_LIMIT_ENABLED, true),
    rateLimitWindowMs: parseDuration(env.RATE_LIMIT_WINDOW || '1m', 60_000),
    rateLimitEntry: envPositiveInteger(env.RATE_LIMIT_ENTRY, 20, 'RATE_LIMIT_ENTRY'),
    rateLimitParticipate: envPositiveInteger(env.RATE_LIMIT_PARTICIPATE, 30, 'RATE_LIMIT_PARTICIPATE'),
    rateLimitAdmin: envPositiveInteger(env.RATE_LIMIT_ADMIN, 120, 'RATE_LIMIT_ADMIN'),
    rateLimitWrite: envPositiveInteger(env.RATE_LIMIT_WRITE, 60, 'RATE_LIMIT_WRITE'),
    rateLimitApi: envPositiveInteger(env.RATE_LIMIT_API, 300, 'RATE_LIMIT_API'),
    apiLogRetentionDays: envPositiveInteger(env.API_LOG_RETENTION_DAYS, 30, 'API_LOG_RETENTION_DAYS'),
    databaseUrl,
    dbPath: dbPath === ':memory:' ? dbPath : resolve(dbPath),
    outboxIntervalMs: parseDuration(env.OUTBOX_INTERVAL || '10s', 10_000),
    autoDrawIntervalMs: parseDuration(env.AUTO_DRAW_INTERVAL || '10s', 10_000),
    groupExpiryIntervalMs: parseDuration(env.GROUP_EXPIRY_INTERVAL || '10s', 10_000),
    rewardCodePrefix: (env.REWARD_CODE_PREFIX || 'S2EXT-').trim().toUpperCase(),
    activityTimeZone: env.ACTIVITY_TIME_ZONE || 'Asia/Shanghai',
    bodyLimitBytes: Number(env.BODY_LIMIT_BYTES || 262_144),
    upstreamTimeoutMs: parseDuration(env.SUB2API_TIMEOUT || '15s', 15_000),
    publicDir: resolve(env.PUBLIC_DIR || DEFAULT_PUBLIC_DIR),
    frameAncestors: frameAncestors(env.FRAME_ANCESTORS, sub2apiBaseUrl)
  };
}

export function assertRuntimeConfig(config) {
  const missing = [];
  if (!config.sub2apiBaseUrl) missing.push('SUB2API_BASE_URL');
  if (!config.sub2apiAdminApiKey) missing.push('SUB2API_ADMIN_API_KEY');
  if (!config.sessionSecret || config.sessionSecret.length < 32) missing.push('SESSION_SECRET(至少32字符)');
  if (config.localTestEnabled && (!config.localTestSecret || config.localTestSecret.length < 32)) {
    missing.push('LOCAL_TEST_SECRET(本地测试开启时至少32字符)');
  }
  if (missing.length) throw badRequest('CONFIG_INVALID', `缺少或无效配置: ${missing.join(', ')}`);
  if (!/^[A-Z0-9_-]{3,8}$/.test(config.rewardCodePrefix)) {
    throw badRequest('CONFIG_INVALID', 'REWARD_CODE_PREFIX 必须为 3 至 8 个大写字母、数字、下划线或连字符');
  }
  if (!Number.isSafeInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw badRequest('CONFIG_INVALID', 'PORT 必须是 1 至 65535 之间的整数');
  }
  if (!Number.isSafeInteger(config.bodyLimitBytes) || config.bodyLimitBytes < 1024) {
    throw badRequest('CONFIG_INVALID', 'BODY_LIMIT_BYTES 必须是不小于 1024 的整数');
  }
  if (!Number.isSafeInteger(config.rateLimitWindowMs) || config.rateLimitWindowMs < 1_000) {
    throw badRequest('CONFIG_INVALID', 'RATE_LIMIT_WINDOW 不能小于 1 秒');
  }
  if (config.localTestEnabled && !['127.0.0.1', '::1', 'localhost'].includes(config.host)) {
    throw badRequest('CONFIG_INVALID', 'LOCAL_TEST_ENABLED 只能在回环地址监听时开启');
  }
  try {
    new Intl.DateTimeFormat('zh-CN', { timeZone: config.activityTimeZone }).format(new Date());
  } catch {
    throw badRequest('CONFIG_INVALID', 'ACTIVITY_TIME_ZONE 必须是有效的 IANA 时区');
  }
}
