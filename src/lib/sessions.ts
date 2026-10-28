import { randomToken, sha256Hex } from '@/lib/crypto';
import { execute, nullable, queryAll, queryOne } from '@/lib/db';
import { UserNotFoundError } from '@/lib/users';
import type { AuthContext, UserRole, UserSessionPublic, UserStatus } from '@/lib/types';

/**
 * Database-backed sessions (C-SESSION-STORE, C-TOKEN).
 *
 * Cookie value: `<sessionId>.<secretHex>` where `sessionId` is 32 hex characters
 * and `secretHex` is 64. Only `sha256(secret)` reaches the database, so a copy of
 * the SQLite file cannot be replayed as a login.
 *
 * The cookie helpers live here rather than in `auth.ts` so that `auth.ts` can
 * depend on this module without an import cycle.
 */

/** Cookie name shared by the console (C-TOKEN). */
export const SESSION_COOKIE = 'aragon_session';

/** Sessions live for seven days (C-TOKEN). */
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const SESSION_TTL_SECONDS = Math.floor(SESSION_TTL_MS / 1000);

/** `last_seen_at` is written at most once per minute: one write per request would
 * turn every console poll into a disk write on the session row. */
export const SESSION_TOUCH_INTERVAL_MS = 60_000;

const SESSION_ID_PATTERN = /^[0-9a-f]{32}$/i;
const SESSION_SECRET_PATTERN = /^[0-9a-f]{64}$/i;
const SESSION_TOKEN_PATTERN = /^([0-9a-f]{32})\.([0-9a-f]{64})$/i;
const USER_AGENT_MAX_LENGTH = 300;
const IP_MAX_LENGTH = 64;

export interface SessionRow {
  id: string;
  user_id: string;
  token_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  user_agent: string | null;
  ip: string | null;
}

export interface SessionCreateOptions {
  now?: number;
  ttlMs?: number;
  userAgent?: string | null;
  ip?: string | null;
}

export interface CreatedSession {
  token: string;
  sessionId: string;
  /** Unix ms; the caller puts it in the cookie's Max-Age. */
  expiresAt: number;
}

/** Parse a cookie value into its two halves. Returns null for anything else. */
export function parseSessionToken(token: unknown): { sessionId: string; secret: string } | null {
  if (typeof token !== 'string') return null;
  const match = SESSION_TOKEN_PATTERN.exec(token.trim());
  const sessionId = match?.[1] ?? '';
  const secret = match?.[2] ?? '';
  if (!SESSION_ID_PATTERN.test(sessionId) || !SESSION_SECRET_PATTERN.test(secret)) return null;
  return { sessionId: sessionId.toLowerCase(), secret: secret.toLowerCase() };
}

/** The only representation of the secret that is persisted. */
export function hashSessionSecret(secret: string): string {
  return sha256Hex(secret);
}

/**
 * The single C-TOKEN shape guard.
 *
 * There used to be a second, identical `isValidSessionTokenShape` export; two names
 * for one rule is exactly how the console gate and the API drift apart, so this is
 * the only entry point (pinned by `tests/unit/user-core/sessions.test.ts`).
 */
export function hasSessionCookieShape(token: unknown): boolean {
  return parseSessionToken(token) !== null;
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return null;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

/**
 * Mint a session for a user.
 *
 * @throws UserNotFoundError when the user id is unknown.
 */
export function createSession(userId: unknown, options: SessionCreateOptions = {}): CreatedSession {
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new UserNotFoundError('cannot create a session for an unknown user');
  }
  const user = queryOne<{ id: string }>('SELECT id FROM users WHERE id = ?', [userId]);
  if (!user) throw new UserNotFoundError('cannot create a session for an unknown user');

  const now = Math.trunc(options.now ?? Date.now());
  const ttlMs = Number.isFinite(options.ttlMs) && (options.ttlMs as number) > 0
    ? Math.trunc(options.ttlMs as number)
    : SESSION_TTL_MS;
  const sessionId = randomToken(16); // 32 hex chars
  const secret = randomToken(32); // 64 hex chars
  const expiresAt = now + ttlMs;

  execute(
    `INSERT INTO user_sessions
      (id, user_id, token_hash, created_at, last_seen_at, expires_at, revoked_at, user_agent, ip)
     VALUES (?, ?, ?, ?, ?, ?, NULL, ?, ?)`,
    [
      sessionId,
      userId,
      hashSessionSecret(secret),
      now,
      now,
      expiresAt,
      nullable(clip(options.userAgent, USER_AGENT_MAX_LENGTH)),
      nullable(clip(options.ip, IP_MAX_LENGTH)),
    ],
  );
  // Opportunistic pruning keeps the table from growing without bound.
  execute('DELETE FROM user_sessions WHERE expires_at < ?', [now - SESSION_TTL_MS]);

  return { token: `${sessionId}.${secret}`, sessionId, expiresAt };
}

/** Parse a `Cookie` request header into a plain object. */
export function parseCookies(header: string | null | undefined): Record<string, string> {
  const result: Record<string, string> = {};
  if (!header) return result;
  for (const part of header.split(';')) {
    const trimmed = part.trim();
    if (trimmed.length === 0) continue;
    const equals = trimmed.indexOf('=');
    if (equals <= 0) continue;
    const name = trimmed.slice(0, equals).trim();
    const rawValue = trimmed.slice(equals + 1).trim();
    if (name.length === 0) continue;
    let value = rawValue;
    if (value.startsWith('"') && value.endsWith('"') && value.length >= 2) {
      value = value.slice(1, -1);
    }
    try {
      result[name] = decodeURIComponent(value);
    } catch {
      result[name] = value;
    }
  }
  return result;
}

/**
 * Extract the session token from `Cookie` (or `Authorization: Bearer` for the
 * PowerShell scripts, which cannot carry a cookie jar).
 */
export function getSessionTokenFromRequest(request: Request): string | null {
  const cookieToken = parseCookies(request.headers.get('cookie'))[SESSION_COOKIE];
  if (cookieToken) return cookieToken;
  const authorization = request.headers.get('authorization');
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match && match[1]) return match[1].trim();
  }
  return null;
}

export interface SessionClientInfo {
  /** Trimmed, control-character-free `User-Agent`, or null when absent. */
  userAgent: string | null;
  /** First hop of `x-forwarded-for` (or `x-real-ip`), or null when absent. */
  ip: string | null;
}

/**
 * Describe the caller for `user_sessions.user_agent` / `.ip`.
 *
 * Only proxy-set headers are read, and an absent header stays `null` instead of a
 * placeholder: the device list in the console must not invent facts about a device.
 * Both values are clipped because both are attacker-controlled request headers.
 */
export function describeSessionClient(request: Request): SessionClientInfo {
  const userAgent = clip(request.headers.get('user-agent'), USER_AGENT_MAX_LENGTH);
  const forwarded = request.headers.get('x-forwarded-for');
  const firstForwarded = typeof forwarded === 'string' ? forwarded.split(',')[0] ?? '' : '';
  const ip =
    clip(firstForwarded, IP_MAX_LENGTH) ?? clip(request.headers.get('x-real-ip'), IP_MAX_LENGTH);
  return { userAgent, ip };
}

interface SessionActorRow {
  id: string;
  user_id: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  revoked_at: number | null;
  user_agent: string | null;
  ip: string | null;
  username: string;
  role: UserRole;
  status: UserStatus;
}

function touchSession(sessionId: string, lastSeenAt: number, now: number): number {
  if (now - lastSeenAt < SESSION_TOUCH_INTERVAL_MS) return lastSeenAt;
  execute('UPDATE user_sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL', [
    now,
    sessionId,
  ]);
  return now;
}

/**
 * Resolve a raw cookie/bearer value to its authenticated actor.
 *
 * Returns `null` - never throws - for a malformed token, an unknown session, an
 * expired session, a revoked session, or a disabled user. The `last_seen_at`
 * write is throttled to once a minute.
 */
export function authenticateSessionToken(
  token: unknown,
  now: number = Date.now(),
): AuthContext | null {
  const parsed = parseSessionToken(token);
  if (!parsed) return null;

  const row = queryOne<SessionActorRow>(
    `SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.expires_at, s.revoked_at,
            s.user_agent, s.ip, u.username, u.role, u.status
       FROM user_sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ? AND s.token_hash = ?`,
    [parsed.sessionId, hashSessionSecret(parsed.secret)],
  );
  if (!row) return null;
  if (row.revoked_at !== null) return null;
  if (Number(row.expires_at) <= now) return null;
  if (row.status !== 'active') return null;

  const timestamp = Math.trunc(now);
  const lastSeenAt = touchSession(String(row.id), Number(row.last_seen_at), timestamp);

  return {
    session: {
      id: String(row.id),
      userId: String(row.user_id),
      createdAt: new Date(Number(row.created_at)).toISOString(),
      lastSeenAt: new Date(lastSeenAt).toISOString(),
      expiresAt: new Date(Number(row.expires_at)).toISOString(),
      userAgent: row.user_agent,
      ip: row.ip,
    },
    user: {
      id: String(row.user_id),
      username: String(row.username),
      role: row.role,
      status: row.status,
    },
  };
}

/** Resolve a request to its authenticated actor (see {@link authenticateSessionToken}). */
export function authenticateRequest(
  request: Request,
  now: number = Date.now(),
): AuthContext | null {
  let token: string | null = null;
  try {
    token = getSessionTokenFromRequest(request);
  } catch {
    return null;
  }
  return authenticateSessionToken(token, now);
}

/**
 * Revoke one session.
 * @returns `false` when the id is unknown; revoking twice is idempotent and
 *   keeps the original `revoked_at`.
 */
export function revokeSession(sessionId: unknown, now: number = Date.now()): boolean {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return false;
  const row = queryOne<{ revoked_at: number | null }>(
    'SELECT revoked_at FROM user_sessions WHERE id = ?',
    [sessionId],
  );
  if (!row) return false;
  if (row.revoked_at !== null) return true;
  execute('UPDATE user_sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL', [
    Math.trunc(now),
    sessionId,
  ]);
  return true;
}

export interface RevokeAllOptions {
  /** Keep this session alive - log out everywhere except the current device. */
  exceptSessionId?: string | null;
  now?: number;
}

/**
 * Revoke every session of a user.
 * @returns the number of sessions that were still active and are now revoked.
 */
export function revokeAllSessions(userId: unknown, options: RevokeAllOptions = {}): number {
  if (typeof userId !== 'string' || userId.length === 0) return 0;
  const now = Math.trunc(options.now ?? Date.now());
  const except = options.exceptSessionId;
  if (typeof except === 'string' && except.length > 0) {
    return execute(
      'UPDATE user_sessions SET revoked_at = ? ' +
        'WHERE user_id = ? AND revoked_at IS NULL AND id != ?',
      [now, userId, except],
    ).changes;
  }
  return execute(
    'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [now, userId],
  ).changes;
}

export interface ListUserSessionsOptions {
  currentSessionId?: string | null;
  now?: number;
}

/**
 * List the live devices of one user, newest first.
 *
 * Expired and revoked sessions are excluded: this list is what the console shows
 * as "currently signed in", and a dead row cannot be signed out.
 */
export function listUserSessions(
  userId: unknown,
  options: ListUserSessionsOptions = {},
): UserSessionPublic[] {
  if (typeof userId !== 'string' || userId.length === 0) return [];
  const now = Math.trunc(options.now ?? Date.now());
  const current = options.currentSessionId ?? null;
  const rows = queryAll<SessionRow>(
    `SELECT * FROM user_sessions
      WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY created_at DESC, id DESC`,
    [userId, now],
  );
  return rows.map((row) => ({
    id: String(row.id),
    createdAt: new Date(Number(row.created_at)).toISOString(),
    lastSeenAt: new Date(Number(row.last_seen_at)).toISOString(),
    expiresAt: new Date(Number(row.expires_at)).toISOString(),
    userAgent: row.user_agent,
    ip: row.ip,
    current: current !== null && String(row.id) === current,
  }));
}

/** Look up one session row without validating its state (console/audit use). */
export function getSessionById(sessionId: unknown): SessionRow | null {
  if (typeof sessionId !== 'string' || sessionId.length === 0) return null;
  return queryOne<SessionRow>('SELECT * FROM user_sessions WHERE id = ?', [sessionId]) ?? null;
}

/** True when the value looks like a session id (never a token). */
export function isSessionId(value: unknown): value is string {
  return typeof value === 'string' && SESSION_ID_PATTERN.test(value);
}

/** True when the value looks like the secret half of a token. */
export function isSessionSecret(value: unknown): value is string {
  return typeof value === 'string' && SESSION_SECRET_PATTERN.test(value);
}
