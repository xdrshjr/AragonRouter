import {
  fail,
  isSecureRequest,
  mapDomainError,
  ok,
  parseJsonBody,
  serverError,
} from '@/lib/api-helpers';
import { serializeSessionCookie } from '@/lib/auth';
import { verifyCaptcha } from '@/lib/captcha';
import { clearFailures, clientFingerprint, isThrottled, recordFailure } from '@/lib/login-throttle';
import { createSession, describeSessionClient } from '@/lib/sessions';
import { assertRegistrationOpen } from '@/lib/settings';
import type { UserPublic } from '@/lib/types';
import { createUser } from '@/lib/users';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * C-AUTH-WIRE: `POST /api/auth/register`
 *
 * `{username,password,displayName?,challengeId,captchaAnswer}` -> `201 {data:{user}}`
 * plus the `aragon_session` cookie, so registering signs the new account in
 * immediately (the UI never has to post the credentials twice).
 *
 * Answers: 400 for malformed input, a bad captcha, a taken username or a weak
 * password; 403 while an administrator has registration switched off; 429 while the
 * shared login throttle is saturated; 500 only for unexpected server faults.
 *
 * The order of the checks is deliberate:
 *  1. throttle - cheapest, and it must stop a flood before any work is done;
 *  2. body shape - every field is bounded once, here at the HTTP boundary;
 *  3. registration switch - an admin closing sign-ups takes effect immediately, and
 *     a request that cannot succeed must not burn a captcha the user would then have
 *     to solve again;
 *  4. captcha - a failed answer counts against the shared throttle budget;
 *  5. reserved name - `admin` belongs to the bootstrap account, never to a signup;
 *  6. account creation - the store re-validates (defence in depth) and owns the
 *     password policy, uniqueness and hashing.
 */

/** Five short fields: 8 KiB is already far beyond any legitimate request. */
const AUTH_BODY_MAX_BYTES = 8 * 1024;
/** Mirrors `validateUsername`; checked here so an oversized body field is refused early. */
const USERNAME_MAX_LENGTH = 32;
/** Mirrors `validatePasswordStrength`; the policy itself is enforced by the store. */
const PASSWORD_MAX_LENGTH = 200;
/** Mirrors `validatePasswordStrength`'s display-name rule in `users.ts`. */
const DISPLAY_NAME_MAX_LENGTH = 64;
/** A challenge id is 32 hex characters; anything longer cannot be one. */
const CAPTCHA_ID_MAX_LENGTH = 64;
/** Mirrors `normalizeCaptchaAnswer`. */
const CAPTCHA_ANSWER_MAX_LENGTH = 16;

const THROTTLED_MESSAGE = 'too many failed attempts, try again in a minute';
/** One message for "missing" and "wrong": a captcha is not an account oracle. */
const CAPTCHA_FAILED_MESSAGE = 'captcha verification failed';
/**
 * The bootstrap account name is reserved for the operator (`users.ts`
 * `ensureBootstrapAdmin`).
 *
 * Registration is open by default, and the bootstrap row is only materialised on the
 * operator's first sign-in. Until then a self-service signup could claim `admin`; the
 * row would then belong to a `member`, and `ensureBootstrapAdmin` would answer
 * `UserRuleError` ("exists but is not an active admin") for good - the operator could
 * no longer sign in as the administrator at all. So the name is refused here, with
 * the same message as any other taken username: whether the bootstrap row already
 * exists must not be observable.
 */
const RESERVED_USERNAMES: readonly string[] = ['admin'];
const USERNAME_TAKEN_MESSAGE = 'username is already taken';

interface RegistrationFields {
  username: string;
  password: string;
  displayName: string | null;
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

/**
 * A secret is never trimmed: `" pass phrase "` and `"pass phrase"` are different
 * passwords, and silently normalising one would lock the user out of their account.
 */
function readSecret(raw: unknown, maxLength: number): string | null {
  if (typeof raw !== 'string') return null;
  if (raw.length === 0 || raw.length > maxLength) return null;
  return raw;
}

/**
 * Optional display name. `undefined`/`null`/empty mean "not provided"; control
 * characters are stripped by the store, so this boundary only checks the type and the
 * length budget.
 */
function readDisplayName(raw: unknown): FieldResult<string | null> {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, message: 'displayName must be a string' };
  if (raw.length > DISPLAY_NAME_MAX_LENGTH * 2) {
    return {
      ok: false,
      message: `displayName must be at most ${DISPLAY_NAME_MAX_LENGTH} characters`,
    };
  }
  return { ok: true, value: raw };
}

/** Validate every field once, at the boundary, before any state is touched. */
function readRegistrationFields(body: Record<string, unknown>): FieldResult<RegistrationFields> {
  const username = readIdentifier(body.username, USERNAME_MAX_LENGTH);
  if (!username) return { ok: false, message: 'username is required' };

  const password = readSecret(body.password, PASSWORD_MAX_LENGTH);
  if (!password) return { ok: false, message: 'password is required' };

  const challengeId = readIdentifier(body.challengeId, CAPTCHA_ID_MAX_LENGTH);
  const captchaAnswer = readIdentifier(body.captchaAnswer, CAPTCHA_ANSWER_MAX_LENGTH);
  if (!challengeId || !captchaAnswer) return { ok: false, message: CAPTCHA_FAILED_MESSAGE };

  const displayName = readDisplayName(body.displayName);
  if (!displayName.ok) return displayName;

  return {
    ok: true,
    value: {
      username,
      password,
      displayName: displayName.value,
      challengeId,
      captchaAnswer,
    },
  };
}

/** Log a failure class without ever echoing a password, an answer or a cookie. */
function describeFailure(error: unknown): string {
  return error instanceof Error ? error.name : 'unknown';
}

/**
 * `verifyCaptcha` reads the challenge row, so a database fault can throw. A thrown
 * error would leave the route with Next's HTML 500 instead of the documented
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

/**
 * Create the account and its first session.
 *
 * Separated from the handler so the response construction (status 201 + cookie) stays
 * readable, and so the "account exists but no cookie" case can be reported honestly
 * instead of pretending the sign-up failed.
 */
function completeRegistration(
  request: Request,
  user: UserPublic,
  now: number,
): Response {
  const client = describeSessionClient(request);
  try {
    const session = createSession(user.id, { now, userAgent: client.userAgent, ip: client.ip });
    return ok({ user }, 201, {
      'set-cookie': serializeSessionCookie(session.token, { secure: isSecureRequest(request) }),
    });
  } catch (error) {
    console.error(
      '[auth] account created but the session could not be created:',
      describeFailure(error),
    );
    return fail('the account was created but signing in failed; please sign in', 500);
  }
}

export async function POST(request: Request): Promise<Response> {
  const now = Date.now();
  const fingerprint = clientFingerprint(request);
  if (isThrottled(fingerprint, now)) return fail(THROTTLED_MESSAGE, 429);

  const parsed = await parseJsonBody(request, AUTH_BODY_MAX_BYTES);
  if (!parsed.ok) return fail(parsed.message, parsed.status);

  const fields = readRegistrationFields(parsed.body);
  if (!fields.ok) return fail(fields.message, 400);
  const input = fields.value;

  try {
    assertRegistrationOpen();
  } catch (error) {
    // Closed registration is a 403; an unreadable settings row is a server fault and
    // must not masquerade as "sign-ups are closed".
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
    console.error('[auth] unable to read the registration switch:', describeFailure(error));
    return serverError('unable to read the registration switch');
  }

  if (!verifyCaptchaOrFail(input.challengeId, input.captchaAnswer, now)) {
    recordFailure(fingerprint, now);
    return fail(CAPTCHA_FAILED_MESSAGE, 400);
  }

  // Checked after the captcha and before the store, exactly like a taken username:
  // the answer is the same 400 and the challenge budget behaves the same way.
  if (RESERVED_USERNAMES.includes(input.username.toLowerCase())) {
    return fail(USERNAME_TAKEN_MESSAGE, 400);
  }

  let user: UserPublic;
  try {
    user = createUser(
      {
        username: input.username,
        password: input.password,
        // Registration never mints an admin: only an admin can promote an account.
        role: 'member',
        displayName: input.displayName ?? undefined,
      },
      now,
    );
  } catch (error) {
    // Taken username, weak password, invalid display name -> 400 with a usable message.
    const mapped = mapDomainError(error);
    if (mapped) return mapped;
    console.error('[auth] unable to create the account:', describeFailure(error));
    return serverError('unable to create the account');
  }

  clearFailures(fingerprint);
  return completeRegistration(request, user, now);
}
