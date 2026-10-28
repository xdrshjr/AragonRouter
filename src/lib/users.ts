import { newId } from '@/lib/crypto';
import { execute, nullable, queryAll, queryOne } from '@/lib/db';
import { getAdminPassword } from '@/lib/env';
import {
  hashPassword,
  normalizeUsernameLower,
  validatePasswordStrength,
  validateUsername,
  verifyPassword,
} from '@/lib/password';
import {
  USER_ROLES,
  USER_STATUSES,
  type UserPublic,
  type UserRole,
  type UserStatus,
} from '@/lib/types';

/**
 * User repository (C-USER-STORE).
 *
 * Everything that reads or writes the `users` table lives here so the route layer
 * never touches `password_hash`. Public reads always go through {@link toPublic},
 * which cannot emit the hash: the DTO simply has no field for it.
 *
 * Rules enforced here (defence in depth - the routes re-check them for 400s):
 *  - the last active admin can never be deleted, disabled or demoted;
 *  - an actor can never disable or delete their own account;
 *  - usernames are unique case-insensitively and validated by `validateUsername`;
 *  - passwords must satisfy `validatePasswordStrength(password, username)`.
 */

const DISPLAY_NAME_MAX_LENGTH = 64;
const BOOTSTRAP_USERNAME = 'admin';
const BOOTSTRAP_DISPLAY_NAME = 'Administrator';
export const DEFAULT_USER_LIMIT = 20;
export const MAX_USER_LIMIT = 100;

/** Bad input from the caller: mapped to HTTP 400. */
export class UserValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserValidationError';
  }
}

/** The request is well-formed but violates an account rule: mapped to HTTP 400. */
export class UserRuleError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UserRuleError';
  }
}

/** No such user: mapped to HTTP 404. */
export class UserNotFoundError extends Error {
  constructor(message = 'user not found') {
    super(message);
    this.name = 'UserNotFoundError';
  }
}

export interface UserRow {
  id: string;
  username: string;
  username_lower: string;
  display_name: string | null;
  password_hash: string;
  role: UserRole;
  status: UserStatus;
  created_at: number;
  updated_at: number;
  last_login_at: number | null;
}

function isoOrNull(value: number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return new Date(Number(value)).toISOString();
}

/** Row -> DTO. The only exit path for user data; never includes the hash. */
export function toPublic(row: UserRow): UserPublic {
  return {
    id: String(row.id),
    username: String(row.username),
    displayName: row.display_name === null ? null : String(row.display_name),
    role: row.role,
    status: row.status,
    createdAt: new Date(Number(row.created_at)).toISOString(),
    updatedAt: new Date(Number(row.updated_at)).toISOString(),
    lastLoginAt: isoOrNull(row.last_login_at),
  };
}

function normalizeDisplayName(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new UserValidationError('displayName must be a string');
  // eslint-disable-next-line no-control-regex
  const cleaned = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (cleaned.length === 0) return null;
  if (cleaned.length > DISPLAY_NAME_MAX_LENGTH) {
    throw new UserValidationError(
      `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    );
  }
  return cleaned;
}

function normalizeRole(value: unknown): UserRole {
  if (value === undefined || value === null) return 'member';
  if (typeof value !== 'string' || !USER_ROLES.includes(value as UserRole)) {
    throw new UserValidationError("role must be 'admin' or 'member'");
  }
  return value as UserRole;
}

function normalizeStatus(value: unknown): UserStatus {
  if (value === undefined || value === null) return 'active';
  if (typeof value !== 'string' || !USER_STATUSES.includes(value as UserStatus)) {
    throw new UserValidationError("status must be 'active' or 'disabled'");
  }
  return value as UserStatus;
}

/** Validate a username and return the trimmed form. */
export function requireValidUsername(raw: unknown): string {
  const problem = validateUsername(raw);
  if (problem) throw new UserValidationError(problem);
  return (raw as string).trim();
}

/** Enforce the password policy for a given owner. */
function requireStrongPassword(password: unknown, username: string): string {
  const verdict = validatePasswordStrength(password, username);
  if (!verdict.ok) throw new UserValidationError(verdict.message ?? 'invalid password');
  return password as string;
}

/** Row lookup by primary key (internal: includes the hash). */
function findRowById(id: unknown): UserRow | null {
  if (typeof id !== 'string' || id.length === 0) return null;
  return queryOne<UserRow>('SELECT * FROM users WHERE id = ?', [id]) ?? null;
}

function findRowByUsername(username: unknown): UserRow | null {
  if (typeof username !== 'string') return null;
  const lower = normalizeUsernameLower(username);
  if (lower.length === 0) return null;
  return queryOne<UserRow>('SELECT * FROM users WHERE username_lower = ?', [lower]) ?? null;
}

export function getUserById(id: unknown): UserPublic | null {
  const row = findRowById(id);
  return row ? toPublic(row) : null;
}

export function findUserByUsername(username: unknown): UserPublic | null {
  const row = findRowByUsername(username);
  return row ? toPublic(row) : null;
}

/** Number of accounts that can still administer the instance. */
export function countActiveAdmins(): number {
  const row = queryOne<{ admins: number }>(
    "SELECT COUNT(*) AS admins FROM users WHERE role = 'admin' AND status = 'active'",
  );
  return row ? Number(row.admins) : 0;
}

/**
 * A verification target used when the username does not exist.
 *
 * Without it a login for an unknown account would return in microseconds while a
 * known one spends ~30ms in scrypt, which is a free account oracle.
 */
let dummyHash: string | null = null;

function getDummyHash(): string {
  if (!dummyHash) dummyHash = hashPassword(`dummy-password-${newId()}`);
  return dummyHash;
}

export interface CreateUserInput {
  username: unknown;
  password: unknown;
  role?: unknown;
  displayName?: unknown;
}

/**
 * Create an account.
 *
 * @throws UserValidationError on a bad username, a weak password, an invalid role
 *   or a username that is already taken.
 */
export function createUser(input: CreateUserInput, now: number = Date.now()): UserPublic {
  const username = requireValidUsername(input.username);
  const role = normalizeRole(input.role);
  const displayName = normalizeDisplayName(input.displayName);
  const password = requireStrongPassword(input.password, username);
  if (findRowByUsername(username)) {
    throw new UserValidationError('username is already taken');
  }

  const id = newId();
  const timestamp = Math.trunc(now);
  execute(
    `INSERT INTO users
      (id, username, username_lower, display_name, password_hash,
         role, status, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?, NULL)`,
    [
      id,
      username,
      normalizeUsernameLower(username),
      nullable(displayName),
      hashPassword(password),
      role,
      timestamp,
      timestamp,
    ],
  );
  const row = findRowById(id);
  if (!row) throw new Error('failed to persist the new user');
  return toPublic(row);
}

/**
 * Check credentials.
 *
 * @returns the public user on success; `null` for an unknown username, a wrong
 *   password **or a disabled account** - the three failures are indistinguishable
 *   to the caller by design.
 */
export function authenticateUser(
  username: unknown,
  password: unknown,
  now: number = Date.now(),
): UserPublic | null {
  const row = findRowByUsername(username);
  if (!row) {
    // Burn the same scrypt cost as a real verification (see getDummyHash).
    verifyPassword(typeof password === 'string' ? password : '', getDummyHash());
    return null;
  }
  if (!verifyPassword(password, row.password_hash)) return null;
  if (row.status !== 'active') return null;

  const timestamp = Math.trunc(now);
  execute('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?', [
    timestamp,
    timestamp,
    row.id,
  ]);
  return toPublic({ ...row, last_login_at: timestamp, updated_at: timestamp });
}

/** The bootstrap account as the C-USER-STORE contract describes it. */
export interface BootstrapAdmin {
  id: string;
  username: string;
  role: 'admin';
  /** `false` when an existing, still valid bootstrap row was reused. */
  created: boolean;
}

/**
 * Create the bootstrap `admin` account on first boot, using `ADMIN_PASSWORD`.
 *
 * Idempotent: an existing `admin` row is returned untouched (never re-hashed, so
 * a rotated password survives a restart).
 *
 * @throws ConfigurationError when `ADMIN_PASSWORD` is unset - an instance with no
 *   bootstrap credential must fail loudly instead of creating a passwordless admin.
 * @throws UserRuleError when an `admin` row exists but is not an active admin: the
 *   contract promises `role: 'admin'`, so returning anything else would invite a
 *   caller to mint an admin session for a member or for a switched-off account.
 *   Promoting the row silently is the other wrong answer - the operator's account
 *   state stays authoritative.
 */
export function ensureBootstrapAdmin(now: number = Date.now()): BootstrapAdmin {
  const existing = findRowByUsername(BOOTSTRAP_USERNAME);
  if (existing) {
    if (existing.role !== 'admin' || existing.status !== 'active') {
      throw new UserRuleError(
        'the "admin" account exists but is not an active admin; promote it or remove it first',
      );
    }
    return {
      id: String(existing.id),
      username: String(existing.username),
      role: 'admin',
      created: false,
    };
  }
  const password = getAdminPassword();
  const id = newId();
  const timestamp = Math.trunc(now);
  execute(
    `INSERT INTO users
      (id, username, username_lower, display_name, password_hash,
         role, status, created_at, updated_at, last_login_at)
     VALUES (?, ?, ?, ?, ?, 'admin', 'active', ?, ?, NULL)`,
    [
      id,
      BOOTSTRAP_USERNAME,
      BOOTSTRAP_USERNAME,
      BOOTSTRAP_DISPLAY_NAME,
      hashPassword(password),
      timestamp,
      timestamp,
    ],
  );
  return { id, username: BOOTSTRAP_USERNAME, role: 'admin', created: true };
}

export interface ListUsersOptions {
  limit?: number | string | null;
  cursor?: string | null;
  search?: string | null;
  role?: string | null;
  status?: string | null;
}

export interface ListUsersResult {
  data: UserPublic[];
  nextCursor: string | null;
}

export function parseUserLimit(value: number | string | null | undefined): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_USER_LIMIT;
  return Math.min(Math.trunc(parsed), MAX_USER_LIMIT);
}

/** Keyset cursor `${created_at}|${id}`, matching the C-USER-STORE contract. */
export function parseUserCursor(
  cursor: string | null | undefined,
): { createdAt: number; id: string } | null {
  if (typeof cursor !== 'string' || cursor.length === 0) return null;
  const separator = cursor.indexOf('|');
  if (separator <= 0) return null;
  const createdAt = Number.parseInt(cursor.slice(0, separator), 10);
  const id = cursor.slice(separator + 1);
  if (!Number.isFinite(createdAt) || id.length === 0) return null;
  return { createdAt, id };
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (match) => `\\${match}`);
}

/**
 * True when an optional list filter actually constrains the query.
 * An absent value and an empty query-string value both mean "no filter".
 */
function hasFilterValue(value: unknown): boolean {
  return value !== undefined && value !== null && value !== '';
}

/**
 * Keyset-paginated user listing, newest first.
 *
 * `search` matches the username or the display name (case-insensitive, `%`/`_`
 * in the term are treated literally).
 *
 * @throws UserValidationError when `role` or `status` is neither empty nor one of
 *   the documented values - callers map it to a 400 instead of showing a user list
 *   that silently is not the one they asked for.
 */
export function listUsers(options: ListUsersOptions = {}): ListUsersResult {
  const limit = parseUserLimit(options.limit);
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  const cursor = parseUserCursor(options.cursor);
  if (cursor) {
    conditions.push('(created_at < ? OR (created_at = ? AND id < ?))');
    params.push(cursor.createdAt, cursor.createdAt, cursor.id);
  }

  const search = typeof options.search === 'string' ? options.search.trim() : '';
  if (search.length > 0) {
    const pattern = `%${escapeLike(search.toLowerCase())}%`;
    // `username_lower` (not `LOWER(username)`) so the search can use the UNIQUE
    // index the schema creates, and so the comparison follows the same
    // case-insensitive normalisation the uniqueness rule uses.
    conditions.push(
      "(username_lower LIKE ? ESCAPE '\\' " +
        "OR LOWER(COALESCE(display_name, '')) LIKE ? ESCAPE '\\')",
    );
    params.push(pattern, pattern);
  }

  // Filters are validated at the boundary instead of being pasted into the WHERE
  // clause: an unknown value is a caller mistake (400), not an empty page that the
  // UI would render as "no users".
  if (hasFilterValue(options.role)) {
    conditions.push('role = ?');
    params.push(normalizeRole(options.role));
  }
  if (hasFilterValue(options.status)) {
    conditions.push('status = ?');
    params.push(normalizeStatus(options.status));
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const rows = queryAll<UserRow>(
    `SELECT * FROM users ${where} ORDER BY created_at DESC, id DESC LIMIT ?`,
    [...params, limit + 1],
  );

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    data: page.map(toPublic),
    nextCursor: hasMore && last ? `${Number(last.created_at)}|${last.id}` : null,
  };
}

export interface UpdateUserInput {
  displayName?: unknown;
  role?: unknown;
  status?: unknown;
}

export interface UpdateUserOptions {
  /**
   * The acting account. When it equals the target, self-disable and
   * self-demotion are refused (C-USER-STORE). Routes pass this from the guard.
   */
  actorId?: string | null;
}

function assertLastAdminSurvives(
  target: UserRow,
  nextRole: UserRole,
  nextStatus: UserStatus,
): void {
  const isActiveAdmin = target.role === 'admin' && target.status === 'active';
  const staysActiveAdmin = nextRole === 'admin' && nextStatus === 'active';
  if (!isActiveAdmin || staysActiveAdmin) return;
  if (countActiveAdmins() <= 1) {
    throw new UserRuleError('at least one active admin must remain');
  }
}

function assertNotSelfLockout(
  target: UserRow,
  actorId: string | null | undefined,
  nextRole: UserRole,
  nextStatus: UserStatus,
): void {
  if (!actorId || actorId !== target.id) return;
  if (nextStatus !== 'active') {
    throw new UserRuleError('you cannot disable your own account');
  }
  if (target.role === 'admin' && nextRole !== 'admin') {
    throw new UserRuleError('you cannot remove your own admin role');
  }
}

/**
 * Patch role / status / display name.
 *
 * @throws UserNotFoundError when the id does not exist, UserValidationError for
 *   malformed input, UserRuleError when the change would lock the instance out.
 */
export function updateUser(
  id: unknown,
  input: UpdateUserInput,
  now: number = Date.now(),
  options: UpdateUserOptions = {},
): UserPublic {
  const target = findRowById(id);
  if (!target) throw new UserNotFoundError();

  const nextRole = input.role === undefined ? target.role : normalizeRole(input.role);
  const nextStatus = input.status === undefined ? target.status : normalizeStatus(input.status);
  const nextDisplayName =
    input.displayName === undefined ? target.display_name : normalizeDisplayName(input.displayName);

  assertLastAdminSurvives(target, nextRole, nextStatus);
  assertNotSelfLockout(target, options.actorId, nextRole, nextStatus);

  execute(
    'UPDATE users SET display_name = ?, role = ?, status = ?, updated_at = ? WHERE id = ?',
    [nullable(nextDisplayName), nextRole, nextStatus, Math.trunc(now), target.id],
  );

  // A disabled account must lose its sessions immediately, otherwise an already
  // authenticated cookie keeps working until it expires.
  if (nextStatus !== 'active') {
    revokeUserSessionsInline(target.id, Math.trunc(now));
  }

  const updated = findRowById(target.id);
  if (!updated) throw new UserNotFoundError();
  return toPublic(updated);
}

/**
 * Revoke every session of a user.
 *
 * Declared here as SQL rather than imported from `sessions.ts` so that the two
 * modules do not import each other (`sessions.ts` depends on this one for the
 * authenticated actor).
 */
function revokeUserSessionsInline(
  userId: string,
  now: number,
  exceptSessionId?: string | null,
): number {
  if (exceptSessionId) {
    return execute(
      'UPDATE user_sessions SET revoked_at = ? ' +
        'WHERE user_id = ? AND revoked_at IS NULL AND id != ?',
      [now, userId, exceptSessionId],
    ).changes;
  }
  return execute(
    'UPDATE user_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL',
    [now, userId],
  ).changes;
}

/**
 * Replace a user's password and revoke every existing session of that user.
 *
 * A password reset is the standard response to a compromised account, so all
 * device sessions are dropped (`exceptSessionId` covers the "change my own
 * password" flow where the current device should stay signed in).
 */
export function setUserPassword(
  id: unknown,
  password: unknown,
  now: number = Date.now(),
  exceptSessionId?: string | null,
): UserPublic {
  const target = findRowById(id);
  if (!target) throw new UserNotFoundError();
  const strong = requireStrongPassword(password, String(target.username));
  execute('UPDATE users SET password_hash = ?, updated_at = ? WHERE id = ?', [
    hashPassword(strong),
    Math.trunc(now),
    target.id,
  ]);
  revokeUserSessionsInline(target.id, Math.trunc(now), exceptSessionId ?? null);
  const updated = findRowById(target.id);
  if (!updated) throw new UserNotFoundError();
  return toPublic(updated);
}

export interface DeleteUserOptions {
  actorId?: string | null;
}

/**
 * Delete an account (sessions cascade).
 *
 * @returns `false` when the id does not exist (idempotent for the route layer).
 * @throws UserRuleError when deleting would remove the last active admin or when
 *   an actor tries to delete their own account.
 */
export function deleteUser(
  id: unknown,
  _now: number = Date.now(),
  options: DeleteUserOptions = {},
): boolean {
  const target = findRowById(id);
  if (!target) return false;
  if (options.actorId && options.actorId === target.id) {
    throw new UserRuleError('you cannot delete your own account');
  }
  if (target.role === 'admin' && target.status === 'active' && countActiveAdmins() <= 1) {
    throw new UserRuleError('at least one active admin must remain');
  }
  // Explicit cleanup as well as the FK: `:memory:` handles and older databases
  // may have been opened before `PRAGMA foreign_keys = ON` took effect.
  execute('DELETE FROM user_sessions WHERE user_id = ?', [target.id]);
  execute('DELETE FROM users WHERE id = ?', [target.id]);
  return true;
}

/** Re-exported so the route layer validates usernames through one entry point. */
export { validateUsername };
