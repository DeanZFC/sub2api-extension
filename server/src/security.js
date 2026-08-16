import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export function randomToken(bytes = 32) {
  return randomBytes(bytes).toString('base64url');
}

export function secretHash(value, secret) {
  return createHmac('sha256', secret).update(value).digest('hex');
}

export function safeSecretEqual(raw, expectedHash, secret) {
  if (!raw || !expectedHash) return false;
  const actual = Buffer.from(secretHash(raw, secret), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function parseCookies(header = '') {
  const cookies = Object.create(null);
  for (const segment of header.split(';')) {
    const index = segment.indexOf('=');
    if (index <= 0) continue;
    const name = segment.slice(0, index).trim();
    const value = segment.slice(index + 1).trim();
    if (!name) continue;
    try {
      cookies[name] = decodeURIComponent(value);
    } catch {
      cookies[name] = value;
    }
  }
  return cookies;
}

export function sessionCookie(config, value, maxAgeSeconds = Math.floor(config.sessionTtlMs / 1000)) {
  const parts = [
    `${config.sessionCookieName}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    `SameSite=${config.sessionCookieSameSite[0].toUpperCase()}${config.sessionCookieSameSite.slice(1)}`,
    `Max-Age=${Math.max(0, maxAgeSeconds)}`
  ];
  if (config.sessionCookieSecure) parts.push('Secure');
  if (config.sessionCookieSameSite === 'none' && config.sessionCookieSecure) parts.push('Partitioned');
  return parts.join('; ');
}

export function validateNextPath(value, fallback = '/') {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string' || value.length > 1024) return fallback;
  let decoded = value;
  for (let i = 0; i < 3; i += 1) {
    if (!decoded.startsWith('/') || decoded.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(decoded)) return fallback;
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      return fallback;
    }
  }
  if (!decoded.startsWith('/') || decoded.startsWith('//') || decoded.includes('\\')) return fallback;
  try {
    const parsed = new URL(value, 'https://extension.invalid');
    if (parsed.origin !== 'https://extension.invalid') return fallback;
  } catch {
    return fallback;
  }
  return value;
}

export function setSecurityHeaders(response, config = {}) {
  response.setHeader('Cache-Control', 'no-store');
  response.setHeader('Pragma', 'no-cache');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  response.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  response.setHeader(
    'Content-Security-Policy',
    `default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors ${config.frameAncestors || "'self'"}; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; form-action 'self'`
  );
}
