import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';

/**
 * Password hashing for the account kernel (WP1 · 口令哈希).
 *
 * `node:crypto` scrypt only - no third-party dependency. The stored string is
 * self-describing so the cost parameters can be raised later without breaking
 * existing rows: `scrypt$N,r,p$salt$hash`.
 *
 * Every function here is total: a corrupted or foreign hash returns `false`
 * instead of throwing, because a login route must never answer 500 for data it
 * cannot parse.
 */

/** One scrypt cost profile. Raising these invalidates nothing (it is per row). */
export interface ScryptParams {
  N: number;
  r: number;
  p: number;
}

/** Spec-mandated default: N=16384, r=8, p=1. */
export const DEFAULT_SCRYPT_PARAMS: ScryptParams = { N: 16_384, r: 8, p: 1 };

export const SCRYPT_PREFIX = 'scrypt';
const SALT_BYTES = 16;
const KEY_BYTES = 64;
/** scrypt's memory use is ~128*N*r bytes; above this we refuse to run it. */
const MAX_ALLOWED_N = 1 << 16;
const MAX_ALLOWED_R = 16;
const MAX_ALLOWED_P = 4;
/**
 * Hard ceiling for the `maxmem` budget handed to `scryptSync`. A row is attacker
 * data once the database file is writable, so the parameters a row may request are
 * bounded to what this product can legitimately produce: without the ceiling a
 * hostile `scrypt$1048576,32,16$...` row would ask for ~4 GiB on every login.
 */
const MAX_SCRYPT_MEMORY_BYTES = 256 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 200;
const MIN_USERNAME_LENGTH = 3;
const MAX_USERNAME_LENGTH = 32;
/**
 * Username fragments shorter than this are not searched for in the password:
 * rejecting every password that contains "a" or "1" would make the rule useless
 * in practice while catching nothing.
 */
const MIN_NAME_FRAGMENT_LENGTH = 3;

// `scrypt$N,r,p$saltHex$hashHex` - the only shape this module will verify.
const PASSWORD_FORMAT_PATTERN =
  /^scrypt\$([0-9]{1,8}),([0-9]{1,4}),([0-9]{1,4})\$([0-9a-f]{16,128})\$([0-9a-f]{32,256})$/i;

/** Why a password was rejected. Stable: the UI mirrors these keys. */
export type PasswordProblem =
  | 'required'
  | 'too_short'
  | 'too_long'
  | 'missing_letter'
  | 'missing_digit'
  | 'contains_username';

export interface PasswordValidation {
  ok: boolean;
  problem: PasswordProblem | null;
  message: string | null;
}

const PASSWORD_MESSAGES: Record<PasswordProblem, string> = {
  required: 'password is required',
  too_short: `password must be at least ${MIN_PASSWORD_LENGTH} characters`,
  too_long: `password must be at most ${MAX_PASSWORD_LENGTH} characters`,
  missing_letter: 'password must contain at least one letter',
  missing_digit: 'password must contain at least one digit',
  contains_username: 'password must not contain the username',
};

function reject(problem: PasswordProblem): PasswordValidation {
  return { ok: false, problem, message: PASSWORD_MESSAGES[problem] };
}

/** Case-insensitive lowercasing shared by the username rules and the hash lookup. */
export function normalizeUsernameLower(username: string): string {
  return username.trim().toLowerCase();
}

/**
 * Split a username into the fragments that must not appear in its password:
 * the whole name plus every `-`/`_`/`.`/digit-free word of at least 3 chars.
 *
 * `alice123` yields `alice123`, `alice`; `bob.smith` yields `bob.smith`, `bob`,
 * `smith`. The result is lowercased and de-duplicated.
 */
export function usernameFragments(username: string | null | undefined): string[] {
  if (typeof username !== 'string') return [];
  const lower = normalizeUsernameLower(username);
  const fragments = new Set<string>();
  if (lower.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(lower);
  for (const part of lower.split(/[^a-z0-9]+/)) {
    if (part.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(part);
  }
  // `alice2024` -> `alice` as well: trailing digits rarely carry identity.
  const withoutDigits = lower.replace(/[0-9]+$/, '');
  if (withoutDigits.length >= MIN_NAME_FRAGMENT_LENGTH) fragments.add(withoutDigits);
  return [...fragments];
}

/**
 * Enforce the password policy: >= 8 characters, at least one letter and one
 * digit, and no username fragment inside the password.
 *
 * @param password Candidate password (any type; non-strings are rejected).
 * @param username Owner of the password; omit for a rule-check without the
 *   fragment test (e.g. validating a reset form before the user is known).
 */
export function validatePasswordStrength(
  password: unknown,
  username?: string | null,
): PasswordValidation {
  if (typeof password !== 'string' || password.length === 0) return reject('required');
  if (password.length < MIN_PASSWORD_LENGTH) return reject('too_short');
  if (password.length > MAX_PASSWORD_LENGTH) return reject('too_long');
  if (!/\p{L}/u.test(password)) return reject('missing_letter');
  if (!/[0-9]/.test(password)) return reject('missing_digit');
  const haystack = password.toLowerCase();
  for (const fragment of usernameFragments(username)) {
    if (haystack.includes(fragment)) return reject('contains_username');
  }
  return { ok: true, problem: null, message: null };
}

/**
 * Validate a username. Returns `null` when it is acceptable, otherwise a
 * human-readable reason suitable for a 400 response.
 *
 * Allowed: 3-32 chars of `a-z`, `A-Z`, `0-9`, `_`, `-`, `.`; it must start with
 * a letter or digit so that no account name can look like a path segment.
 */
export function validateUsername(raw: unknown): string | null {
  if (typeof raw !== 'string') return 'username is required';
  const username = raw.trim();
  if (username.length === 0) return 'username is required';
  if (username.length < MIN_USERNAME_LENGTH) {
    return `username must be at least ${MIN_USERNAME_LENGTH} characters`;
  }
  if (username.length > MAX_USERNAME_LENGTH) {
    return `username must be at most ${MAX_USERNAME_LENGTH} characters`;
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(username)) {
    return (
      'username may only contain letters, digits, dot, dash and underscore, ' +
      'and must start with a letter or digit'
    );
  }
  return null;
}

/** Parse the cost profile out of a stored hash; `null` when malformed. */
export function parsePasswordHash(
  stored: unknown,
): { params: ScryptParams; salt: Buffer; hash: Buffer } | null {
  if (typeof stored !== 'string') return null;
  const match = PASSWORD_FORMAT_PATTERN.exec(stored.trim());
  if (!match) return null;
  const N = Number.parseInt(match[1] ?? '', 10);
  const r = Number.parseInt(match[2] ?? '', 10);
  const p = Number.parseInt(match[3] ?? '', 10);
  if (!Number.isFinite(N) || !Number.isFinite(r) || !Number.isFinite(p)) return null;
  // A hostile row must not be able to pin a CPU: bound the parameters before use.
  if (N < 2 || N > MAX_ALLOWED_N || (N & (N - 1)) !== 0) return null;
  if (r < 1 || r > MAX_ALLOWED_R || p < 1 || p > MAX_ALLOWED_P) return null;
  const salt = Buffer.from(match[4] ?? '', 'hex');
  const hash = Buffer.from(match[5] ?? '', 'hex');
  if (salt.length === 0 || hash.length === 0) return null;
  return { params: { N, r, p }, salt, hash };
}

/** Derive the raw scrypt digest. Throws only for absurd cost parameters. */
function derive(password: string, salt: Buffer, params: ScryptParams): Buffer {
  // `maxmem` is derived from N so that raising N for one row cannot fail: the
  // default 32 MiB limit is below what N=16384,r=8 needs once Node adds overhead.
  // The absolute ceiling keeps even the largest accepted profile bounded.
  const maxmem = Math.min(256 * params.N * params.r, MAX_SCRYPT_MEMORY_BYTES);
  return scryptSync(password, salt, KEY_BYTES, {
    N: params.N,
    r: params.r,
    p: params.p,
    maxmem,
  });
}

/**
 * Hash a password with a fresh random salt.
 *
 * @returns the storable string `scrypt$N,r,p$saltHex$hashHex`.
 */
export function hashPassword(
  password: unknown,
  params: ScryptParams = DEFAULT_SCRYPT_PARAMS,
): string {
  if (typeof password !== 'string' || password.length === 0) {
    throw new TypeError('hashPassword() expects a non-empty string password');
  }
  const salt = randomBytes(SALT_BYTES);
  const digest = derive(password, salt, params);
  return `${SCRYPT_PREFIX}$${params.N},${params.r},${params.p}` +
    `$${salt.toString('hex')}$${digest.toString('hex')}`;
}

/**
 * Verify a password against a stored hash in constant time.
 *
 * Returns `false` - never throws - for a wrong password, a malformed hash, a
 * hash written by another algorithm, or an empty/absent value.
 */
export function verifyPassword(password: unknown, stored: unknown): boolean {
  if (typeof password !== 'string' || password.length === 0) return false;
  const parsed = parsePasswordHash(stored);
  if (!parsed) return false;
  let candidate: Buffer;
  try {
    candidate = derive(password, parsed.salt, parsed.params);
  } catch {
    // Unreachable for params that passed parsePasswordHash's bounds, but a
    // verification failure must never surface as an exception.
    return false;
  }
  if (candidate.length !== parsed.hash.length) return false;
  return timingSafeEqual(candidate, parsed.hash);
}

/** True when a stored value already is a well-formed scrypt hash. */
export function isPasswordHash(value: unknown): boolean {
  return parsePasswordHash(value) !== null;
}
