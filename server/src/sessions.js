import { forbidden, unauthorized } from './errors.js';
import { parseCookies, randomToken, safeSecretEqual, secretHash } from './security.js';

export class SessionStore {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.findStatement = db.prepare(`
      SELECT session_hash, csrf_hash, user_id, role, email, username, created_at, expires_at, last_seen_at
      FROM sessions WHERE session_hash = ? AND expires_at > ?
    `);
  }

  create(user, now = new Date()) {
    const sessionToken = randomToken(32);
    const csrfToken = randomToken(24);
    const createdAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + this.config.sessionTtlMs).toISOString();
    this.db.prepare(`
      INSERT INTO sessions(session_hash, csrf_hash, user_id, role, email, username, created_at, expires_at, last_seen_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      secretHash(sessionToken, this.config.sessionSecret),
      secretHash(csrfToken, this.config.sessionSecret),
      Number(user.id),
      String(user.role || 'user'),
      String(user.email || ''),
      String(user.username || ''),
      createdAt,
      expiresAt,
      createdAt
    );
    return { sessionToken, csrfToken, expiresAt };
  }

  getFromRequest(request, { required = true } = {}) {
    const cookieToken = parseCookies(request.headers.cookie)[this.config.sessionCookieName];
    const headerToken = this.config.localTestEnabled
      ? sessionAuthorizationToken(request.headers.authorization)
      : '';
    const tokens = [...new Set([cookieToken, headerToken].filter(Boolean))];
    if (tokens.length === 0) {
      if (required) throw unauthorized();
      return null;
    }
    const expiresAfter = new Date().toISOString();
    let rawToken = '';
    let hash = '';
    let session = null;
    for (const token of tokens) {
      const candidateHash = secretHash(token, this.config.sessionSecret);
      const candidate = this.findStatement.get(candidateHash, expiresAfter);
      if (!candidate) continue;
      rawToken = token;
      hash = candidateHash;
      session = candidate;
      break;
    }
    if (!session) {
      if (required) throw unauthorized();
      return null;
    }
    const now = new Date();
    if (now.getTime() - new Date(session.last_seen_at).getTime() >= 300_000) {
      this.db.prepare('UPDATE sessions SET last_seen_at = ? WHERE session_hash = ?').run(now.toISOString(), hash);
    }
    return { ...session, rawToken };
  }

  assertCsrf(request, session) {
    const token = request.headers['x-csrf-token'];
    if (typeof token !== 'string' || !safeSecretEqual(token, session.csrf_hash, this.config.sessionSecret)) {
      throw forbidden('CSRF 验证失败，请刷新页面后重试');
    }
  }

  csrfTokenForSession(session) {
    // CSRF values are intentionally not reversible. A fresh token rotates the stored hash.
    const token = randomToken(24);
    this.db.prepare('UPDATE sessions SET csrf_hash = ? WHERE session_hash = ?')
      .run(secretHash(token, this.config.sessionSecret), session.session_hash);
    session.csrf_hash = secretHash(token, this.config.sessionSecret);
    return token;
  }

  delete(session) {
    this.db.prepare('DELETE FROM sessions WHERE session_hash = ?').run(session.session_hash);
  }

  cleanup(now = new Date()) {
    return this.db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now.toISOString()).changes;
  }
}

function sessionAuthorizationToken(value) {
  if (typeof value !== 'string') return '';
  return /^Session ([A-Za-z0-9_-]{32,128})$/.exec(value)?.[1] || '';
}

export function requireAdmin(session) {
  if (session.role !== 'admin') throw forbidden('仅管理员可访问此接口');
}
