import { beforeEach, describe, expect, it } from 'vitest';
import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  SESSION_TTL_SECONDS,
  createSessionToken,
  endSession,
  getAuthContext,
  getSessionTokenFromRequest,
  isAdminRequest,
  isSecureRequest,
  parseCookies,
  requireAdmin,
  requireSession,
  serializeClearedSessionCookie,
  serializeSessionCookie,
  verifyAdminPassword,
  verifySessionToken,
  verifyUserPassword,
} from '@/lib/auth';
import { sha256Hex } from '@/lib/crypto';
import { execute, queryOne } from '@/lib/db';
import { hashPassword } from '@/lib/password';
import { createSession, revokeSession } from '@/lib/sessions';
import { ensureBootstrapAdmin, createUser, setUserPassword, updateUser } from '@/lib/users';
import {
  TEST_ADMIN_PASSWORD,
  TEST_MEMBER_PASSWORD,
  adminHeaders,
  bootstrapAdmin,
  createMemberUser,
  prepareTestEnv,
} from './test-helpers';

/**
 * `src/lib/auth.ts` after the move to database sessions.
 *
 * Two things are pinned here:
 *  1. the **legacy export surface** (`SESSION_COOKIE`, `SESSION_TTL_MS`,
 *     `parseCookies`, `getSessionTokenFromRequest`, `serializeSessionCookie`,
 *     `serializeClearedSessionCookie`, `isSecureRequest`, `verifyAdminPassword`,
 *     `createSessionToken`, `verifySessionToken`, `isAdminRequest`,
 *     `requireAdmin`) still exists with the same signature, because routes,
 *     scripts and the console import them by name;
 *  2. the new **semantics**: a cookie is a `<sessionId>.<secret>` pair backed by
 *     a `user_sessions` row, so expiry, revocation and a disabled owner all fail
 *     closed, and the secret itself is never stored.
 */

beforeEach(() => {
  prepareTestEnv();
});

describe('auth: bootstrap password', () => {
  it('accepts the configured ADMIN_PASSWORD', () => {
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
  });

  it('rejects wrong, empty and non-string candidates', () => {
    expect(verifyAdminPassword('nope')).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
    expect(verifyAdminPassword(undefined)).toBe(false);
    expect(verifyAdminPassword(123)).toBe(false);
    expect(verifyAdminPassword(null)).toBe(false);
    expect(verifyAdminPassword({})).toBe(false);
  });

  it('fails closed when ADMIN_PASSWORD is not configured', () => {
    delete process.env.ADMIN_PASSWORD;
    try {
      expect(verifyAdminPassword('anything')).toBe(false);
    } finally {
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }
  });

  it('verifies the seeded admin row once the bootstrap password has been hashed', () => {
    bootstrapAdmin();
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
    expect(verifyAdminPassword(`${TEST_ADMIN_PASSWORD}-wrong`)).toBe(false);
  });

  it('treats the stored row as authoritative: a reset retires both older credentials', () => {
    const admin = bootstrapAdmin();
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);

    // The row password diverges from the environment value ...
    setUserPassword(admin.id, 'S3cond-Bootstrap-Pass');
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(false);
    expect(verifyAdminPassword('S3cond-Bootstrap-Pass')).toBe(true);

    // ... and a second reset retires the previous row password as well.
    setUserPassword(admin.id, 'N3w-Bootstrap-Pass');
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(false);
    expect(verifyAdminPassword('S3cond-Bootstrap-Pass')).toBe(false);
    expect(verifyAdminPassword('N3w-Bootstrap-Pass')).toBe(true);
  });

  it('ignores a rotated ADMIN_PASSWORD once the admin row exists', () => {
    bootstrapAdmin();
    process.env.ADMIN_PASSWORD = 'Rotated-Env-Passw0rd';
    try {
      expect(verifyAdminPassword('Rotated-Env-Passw0rd')).toBe(false);
      expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);
    } finally {
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }
  });

  /**
   * Regression (disabled-owner login): this helper used to compare the hash only, so a
   * caller could obtain a session for an account an operator had switched off. The
   * account status is part of the credential now.
   */
  it('refuses every candidate once the admin row is disabled', () => {
    const admin = bootstrapAdmin();
    createUser({ username: 'status-controller', password: 'Zq7-Quiet-Value-4', role: 'admin' });
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(true);

    updateUser(admin.id, { status: 'disabled' }, Date.now(), { actorId: 'status-controller' });
    expect(verifyAdminPassword(TEST_ADMIN_PASSWORD)).toBe(false);
    expect(verifyAdminPassword('')).toBe(false);
    // The stored hash is untouched: only the account state changed.
    const row = queryOne<{ password_hash: string }>(
      'SELECT password_hash FROM users WHERE id = ?',
      [admin.id],
    );
    expect(String(row?.password_hash)).toMatch(/^scrypt\$/);
  });

  it('verifies a stored scrypt hash without ever returning it', () => {
    const stored = hashPassword('some-password-1');
    expect(verifyUserPassword('some-password-1', stored)).toBe(true);
    expect(verifyUserPassword('some-password-2', stored)).toBe(false);
    expect(verifyUserPassword('some-password-1', 'not-a-hash')).toBe(false);
  });
});

describe('auth: database-backed session tokens (C-TOKEN)', () => {
  it('exposes the documented constants', () => {
    expect(SESSION_COOKIE).toBe('aragon_session');
    expect(SESSION_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(SESSION_TTL_SECONDS).toBe(604_800);
  });

  it('mints <32 hex sessionId>.<64 hex secret> tokens that verify', () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(now);
    expect(token).toMatch(/^[0-9a-f]{32}\.[0-9a-f]{64}$/);
    const [sessionId, secret] = token.split('.');
    expect(verifySessionToken(token, now)).toBe(true);
    expect(verifySessionToken(token, now + SESSION_TTL_MS - 1000)).toBe(true);

    // The row exists, stores only the hash of the secret, and expires after 7 days.
    const row = queryOne<{ id: string; token_hash: string; expires_at: number }>(
      'SELECT id, token_hash, expires_at FROM user_sessions WHERE id = ?',
      [sessionId ?? ''],
    );
    expect(row?.id).toBe(sessionId);
    expect(row?.token_hash).toBe(sha256Hex(secret ?? ''));
    expect(row?.token_hash).not.toContain(secret ?? '#');
    expect(Number(row?.expires_at)).toBe(now + SESSION_TTL_MS);
  });

  it('expires after seven days', () => {
    const now = 1_700_000_000_000;
    const token = createSessionToken(now);
    expect(verifySessionToken(token, now + SESSION_TTL_MS + 1)).toBe(false);
  });

  it('rejects forged, truncated and mismatched secrets', () => {
    const now = Date.now();
    const token = createSessionToken(now);
    const [sessionId] = token.split('.');
    const forged = [
      '',
      'garbage',
      `${sessionId}.${'0'.repeat(64)}`,
      `${'0'.repeat(32)}.${'a'.repeat(64)}`,
      `${sessionId}.${'a'.repeat(63)}`,
      `${sessionId}.${'a'.repeat(65)}`,
      `${sessionId}.${'a'.repeat(64)}.extra`,
      `${Date.now()}.${'a'.repeat(64)}`,
      `Bearer ${token}`,
    ];
    for (const candidate of forged) {
      expect(verifySessionToken(candidate, now), candidate).toBe(false);
    }
    expect(verifySessionToken(undefined, now)).toBe(false);
    expect(verifySessionToken(123, now)).toBe(false);
  });

  it('rejects a revoked session even though the token is well-formed', () => {
    const token = createSessionToken();
    const sessionId = token.split('.')[0] ?? '';
    expect(verifySessionToken(token)).toBe(true);
    expect(revokeSession(sessionId)).toBe(true);
    expect(verifySessionToken(token)).toBe(false);
  });

  it('rejects the session of a disabled user', () => {
    const member = createMemberUser('token-disabled');
    const session = createSession(member.id);
    expect(verifySessionToken(session.token)).toBe(true);
    execute("UPDATE users SET status = 'disabled' WHERE id = ?", [member.id]);
    expect(verifySessionToken(session.token)).toBe(false);
  });

  it('fails closed when no bootstrap admin can be created', () => {
    delete process.env.ADMIN_PASSWORD;
    try {
      expect(() => createSessionToken()).toThrow(/ADMIN_PASSWORD/);
      expect(verifySessionToken('123.sig')).toBe(false);
    } finally {
      process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
    }
  });
});

describe('auth: cookies and request guards', () => {
  it('parses a Cookie header including quoted and encoded values', () => {
    expect(parseCookies('a=1; b=two; aragon_session=x.y')).toEqual({
      a: '1',
      b: 'two',
      aragon_session: 'x.y',
    });
    expect(parseCookies('q="quoted"; enc=a%20b')).toEqual({ q: 'quoted', enc: 'a b' });
    expect(parseCookies(undefined)).toEqual({});
    expect(parseCookies('broken')).toEqual({});
  });

  it('extracts the token from the cookie first and from Bearer second', () => {
    const viaCookie = new Request('http://localhost/api/admin/keys', {
      headers: { cookie: `other=1; ${SESSION_COOKIE}=abc.def` },
    });
    expect(getSessionTokenFromRequest(viaCookie)).toBe('abc.def');
    const viaBearer = new Request('http://localhost/api/admin/keys', {
      headers: { authorization: 'Bearer xyz.123' },
    });
    expect(getSessionTokenFromRequest(viaBearer)).toBe('xyz.123');
    expect(getSessionTokenFromRequest(new Request('http://localhost/'))).toBeNull();
    expect(
      getSessionTokenFromRequest(
        new Request('http://localhost/', { headers: { authorization: 'Basic abc' } }),
      ),
    ).toBeNull();
  });

  it('serializes a HttpOnly SameSite=Lax session cookie', () => {
    const cookie = serializeSessionCookie('123.sig');
    expect(cookie).toContain(`${SESSION_COOKIE}=123.sig`);
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Max-Age=604800');
    expect(cookie).not.toContain('Secure');
    expect(serializeSessionCookie('123.sig', { maxAgeSeconds: 60, secure: true })).toContain(
      'Max-Age=60',
    );
    expect(serializeSessionCookie('123.sig', { secure: true })).toContain('Secure');
  });

  it('serializes a cleared cookie', () => {
    const cookie = serializeClearedSessionCookie();
    expect(cookie).toContain(`${SESSION_COOKIE}=;`);
    expect(cookie).toContain('Max-Age=0');
    expect(serializeClearedSessionCookie(true)).toContain('Secure');
  });

  it('only marks the request secure when it really is HTTPS', () => {
    expect(
      isSecureRequest(
        new Request('https://localhost/api/admin/keys', { headers: { 'x-forwarded-proto': 'https' } }),
      ),
    ).toBe(true);
    expect(
      isSecureRequest(
        new Request('http://localhost/api/admin/keys', {
          headers: { 'x-forwarded-proto': 'http, https' },
        }),
      ),
    ).toBe(false);
    expect(isSecureRequest(new Request('https://localhost/api/admin/keys'))).toBe(true);
    expect(isSecureRequest(new Request('http://localhost/api/admin/keys'))).toBe(false);
  });

  it('requireAdmin accepts a live admin cookie and a live bearer token', () => {
    const { cookie } = adminHeaders();
    const withCookie = new Request('http://localhost/api/admin/keys', { headers: { cookie: cookie ?? '' } });
    expect(requireAdmin(withCookie)).toBe(true);
    expect(isAdminRequest(withCookie)).toBe(true);

    const token = createSessionToken();
    const withBearer = new Request('http://localhost/api/admin/keys', {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(requireAdmin(withBearer)).toBe(true);
    expect(getAuthContext(withBearer)?.user.role).toBe('admin');
  });

  it('requireAdmin rejects missing, malformed and unknown cookies', () => {
    expect(requireAdmin(new Request('http://localhost/api/admin/keys'))).toBe(false);
    expect(
      requireAdmin(
        new Request('http://localhost/api/admin/keys', {
          headers: { cookie: `${SESSION_COOKIE}=garbage` },
        }),
      ),
    ).toBe(false);
    const unknown = `${'a'.repeat(32)}.${'b'.repeat(64)}`;
    expect(
      requireAdmin(
        new Request('http://localhost/api/admin/keys', {
          headers: { cookie: `${SESSION_COOKIE}=${unknown}` },
        }),
      ),
    ).toBe(false);
  });

  it('treats a member session as authenticated but not as an admin', () => {
    const member = createMemberUser('auth-member');
    const session = createSession(member.id);
    const request = new Request('http://localhost/api/admin/keys', {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(requireSession(request)?.user.role).toBe('member');
    expect(isAdminRequest(request)).toBe(false);
    expect(getAuthContext(request)?.user.username).toBe('auth-member');
  });

  it('logs out by revoking the session behind the cookie', () => {
    const member = createMemberUser('auth-logout', { password: TEST_MEMBER_PASSWORD });
    const session = createSession(member.id);
    const request = new Request('http://localhost/api/admin/session', {
      headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
    });
    expect(endSession(request)).toBe(true);
    expect(verifySessionToken(session.token)).toBe(false);
    expect(endSession(request)).toBe(false);
  });

  it('never puts a password, a hash or a token fragment in the cookie attributes', () => {
    const admin = ensureBootstrapAdmin();
    const row = queryOne<{ password_hash: string }>('SELECT password_hash FROM users WHERE id = ?', [
      admin.id,
    ]);
    const cookie = serializeSessionCookie(createSession(admin.id).token);
    expect(cookie).not.toContain(TEST_ADMIN_PASSWORD);
    expect(cookie).not.toContain(String(row?.password_hash));
    expect(cookie).not.toContain('scrypt$');
  });
});
