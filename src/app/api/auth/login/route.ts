import {
  fail,
  isSecureRequest,
  ok,
  parseJsonBody,
  serverError,
} from '@/lib/api-helpers';
import { serializeSessionCookie } from '@/lib/auth';
import { verifyCaptcha } from '@/lib/captcha';
import { clearFailures, clientFingerprint, isThrottled, recordFailure } from '@/lib/login-throttle';
import { createSession, describeSessionClient } from '@/lib/sessions';
import type { UserPublic } from '@/lib/types';
import { authenticateUser, ensureBootstrapAdmin, validateUsername } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-AUTH-WIRE: `POST /api/auth/login`
 *
 * `{username,password,challengeId,captchaAnswer}` -> `200 {data:{user}}` plus
 * `Set-Cookie: aragon_session=...`. Both `admin` and `member` accounts sign in here;
 * no role check belongs on this route (`/api/admin/**` enforces the admin door).
 *
 * Failure answers:
 *  - 400 - malformed body, or a missing/wrong captcha (the challenge is not consumed
 *    on success only: a wrong answer burns one of its five attempts);
 *  - 401 - **one** message for a wrong password, an unknown username and a disabled
 *    account. Anything more specific is a free account oracle, and the throttle would
 *    then only slow down the attack that is already being reported;
 *  - 429 - the shared login/registration throttle is saturated for this fingerprint.
 *    The captcha alone is not enough: a solved captcha proves a human is present once,
 *    not that the same human may keep guessing passwords.
 *
 * The captcha is checked *before* the credentials: without that order an attacker
 * could use this endpoint as a password oracle for free and only solve captchas for
 * the guess that would have succeeded.
 */

/** Four short fields: 8 KiB is already far beyond any legitimate request. */
const AUTH_BODY_MAX_BYTES = 8 * 1024;
/** Mirrors `validateUsername`; a longer value cannot be an existing account. */
const USERNAME_MAX_LENGTH = 32;
/** Mirrors `validatePasswordStrength`; a longer value cannot be a stored password. */
const PASSWORD_MAX_LENGTH = 200;
/** A challenge id is 32 hex characters; anything longer cannot be one. */
const CAPTCHA_ID_MAX_LENGTH = 64;
/** Mirrors `normalizeCaptchaAnswer`. */
const CAPTCHA_ANSWER_MAX_LENGTH = 16;

const THROTTLED_MESSAGE = 'too many failed attempts, try again in a minute';
/** One message for "missing" and "wrong": a captcha is not an account oracle. */
const CAPTCHA_FAILED_MESSAGE = 'captcha verification failed';
/** Never distinguishes "no such user" from "wrong password" from "account disabled". */
const CREDENTIAL_ERROR_MESSAGE = 'invalid username or password';
/** Mirrors `users.ts`: the bootstrap account is materialised on first sign-in. */
const BOOTSTRAP_USERNAME = 'admin';

interface LoginFields {
  username: string;
  password: string;
  challengeId: string;
  captchaAnswer: string;
}

type FieldResult<T> = { ok: true; value: T } | { ok: false; message: string };

/** Trimmed, non-empty, bounded identifier (username, challenge id, captcha answer). */
function readIdentifier(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) return null;
  return trimmed;
}

/** A password is never trimmed: whitespace is part of the secret. */
function readSecret(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > maxLength) return null;
  return raw;
}

/** Validate the whole body once, at the boundary, before any credential work. */
function readLoginFields(body: Record<string, unknown>): FieldResult<LoginFields> {
  const username = readIdentifier(body.username, USERNAME_MAX_LENGTH);
  const password = readSecret(body.password, PASSWORD_MAX_LENGTH);
  if (!username || !password) return { ok: false, message: 'username and password are required' };

  const challengeId = readIdentifier(body.challengeId, CAPTCHA_ID_MAX_LENGTH);
  const captchaAnswer = readIdentifier(body.captchaAnswer, CAPTCHA_ANSWER_MAX_LENGTH);
  if (!challengeId || !captchaAnswer) return { ok: false, message: CAPTCHA_FAILED_MESSAGE };

  return { ok: true, value: { username, password, challengeId, captchaAnswer } };
}

/** Log a failure class without ever echoing a password, an answer or a cookie. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * Materialise the bootstrap `admin` row on first sign-in.
 *
 * A database that has never been bootstrapped has no `users` row, so the only
 * credential that exists is `ADMIN_PASSWORD`; hashing it into the `admin` account here
 * (idempotent) is what lets the console's login modal work on a fresh install. A
 * missing `ADMIN_PASSWORD` is not a config error for this route: there is simply
 * nothing to verify against, and the caller gets the ordinary 401.
 */
function ensureBootstrapRow(): void {
  try {
    ensureBootstrapAdmin();
  } catch (error) {
    console.error('[auth] bootstrap admin is not available:', describeFailure(error));
  }
}

/** Mint the session and answer `200 {data:{user}}` with the C-TOKEN cookie. */
function completeLogin(request: Request, user: UserPublic, now: number): Response {
  const client = describeSessionClient(request);
  try {
    const session = createSession(user.id, { now, userAgent: client.userAgent, ip: client.ip });
    return ok({ user }, 200, {
      'set-cookie': serializeSessionCookie(session.token, { secure: isSecureRequest(request) }),
    });
  } catch (error) {
    // No token, no password and no hash in the log line: only the failure class.
    console.error('[auth] unable to create a session:', describeFailure(error));
    return serverError('unable to create a session');
  }
}

export async function POST(request: Request): Promise<Response> {
  const now = Date.now();
  const fingerprint = clientFingerprint(request);
  if (isThrottled(fingerprint, now)) return fail(THROTTLED_MESSAGE, 429);

  const parsed = await parseJsonBody(request, AUTH_BODY_MAX_BYTES);
  if (!parsed.ok) return fail(parsed.message, parsed.status);

  const fields = readLoginFields(parsed.body);
  if (!fields.ok) return fail(fields.message, 400);
  const input = fields.value;

  if (!verifyCaptchaOrFail(input.challengeId, input.captchaAnswer, now)) {
    recordFailure(fingerprint, now);
    return fail(CAPTCHA_FAILED_MESSAGE, 400);
  }

  if (input.username.toLowerCase() === BOOTSTRAP_USERNAME) ensureBootstrapRow();

  // A username that cannot exist is answered exactly like a wrong password, so the
  // response time and the message never reveal whether the account is real.
  if (validateUsername(input.username) !== null) {
    recordFailure(fingerprint, now);
    return fail(CREDENTIAL_ERROR_MESSAGE, 401);
  }

  const user = authenticateOrNull(input.username, input.password, now);
  if (!user) {
    recordFailure(fingerprint, now);
    return fail(CREDENTIAL_ERROR_MESSAGE, 401);
  }

  clearFailures(fingerprint);
  return completeLogin(request, user, now);
}

/**
 * `verifyCaptcha` reads the challenge row, so a database fault can throw here. A
 * thrown error would leave the route with Next's HTML 500 instead of the documented
 * envelope, so it is answered as a plain "not verified" and logged by class only.
 */
function verifyCaptchaOrFail(challengeId: string, answer: string, now: number): boolean {
  try {
    return verifyCaptcha(challengeId, answer, now);
  } catch (error) {
    console.error('[auth] unable to verify the captcha:', describeFailure(error));
    return false;
  }
}

/** `authenticateUser` may throw on an unreachable database; a guest then gets nothing. */
function authenticateOrNull(username: string, password: string, now: number): UserPublic | null {
  try {
    return authenticateUser(username, password, now);
  } catch (error) {
    console.error('[auth] unable to verify the credentials:', describeFailure(error));
    return null;
  }
}
