import { createCaptcha } from '@/lib/captcha';
import { SESSION_COOKIE, createSession } from '@/lib/sessions';
import { TEST_MEMBER_PASSWORD, jsonRequest, prepareTestEnv, readJson } from '../test-helpers';

/**
 * Shared fixtures for the account/auth route suites (`tests/unit/user-api/**`).
 *
 * Everything here goes through the production code paths: captchas are real
 * `captcha_challenges` rows with a *known* answer (`createCaptcha({answer})` is the
 * documented test hook), sessions are real `user_sessions` rows, and the `Response`
 * objects are the ones the handlers returned - cookies are read back from the real
 * `Set-Cookie` header instead of being assumed.
 */

export const BASE_URL = 'http://localhost';

/**
 * The fixed captcha answer the harness mints.
 *
 * `createCaptcha` only stores `sha256(id:answer)`, so a test cannot read the answer back
 * from the database. Minting a challenge with a known answer is therefore the only
 * honest way to prove that "a correct captcha is required and is consumed by a
 * success"; guessing glyphs out of an SVG would test the renderer, not the route.
 */
export const CAPTCHA_ANSWER = 'ABC23';

/** The password every harness-created member uses (satisfies the policy). */
export const HARNESS_MEMBER_PASSWORD = TEST_MEMBER_PASSWORD;

export interface SolvedCaptcha {
  challengeId: string;
  captchaAnswer: string;
}

/** Mint a live challenge plus the answer that solves it. */
export function issueCaptcha(answer: string = CAPTCHA_ANSWER): SolvedCaptcha {
  const challenge = createCaptcha(Date.now(), { answer });
  return { challengeId: challenge.id, captchaAnswer: answer };
}

/** A challenge id that no row backs (verification always fails). */
export const UNKNOWN_CHALLENGE_ID = 'f'.repeat(32);

export interface LoginPayload extends Record<string, unknown> {
  username: string;
  password: string;
  challengeId: string;
  captchaAnswer: string;
}

/** Build a `POST /api/auth/login` body; pass `captcha: null` to omit the fields. */
export function loginPayload(
  username: string,
  password: string,
  captcha: SolvedCaptcha | null = issueCaptcha(),
): LoginPayload {
  const base = { username, password };
  if (!captcha) return { ...base, challengeId: '', captchaAnswer: '' };
  return { ...base, challengeId: captcha.challengeId, captchaAnswer: captcha.captchaAnswer };
}

export interface RegisterPayload extends Record<string, unknown> {
  username: string;
  password: string;
  challengeId: string;
  captchaAnswer: string;
  displayName?: string;
}

/** Build a `POST /api/auth/register` body, overridable field by field. */
export function registerPayload(
  overrides: Partial<RegisterPayload> = {},
  captcha: SolvedCaptcha | null = issueCaptcha(),
): RegisterPayload {
  const payload: RegisterPayload = {
    username: 'harness-member',
    password: HARNESS_MEMBER_PASSWORD,
    displayName: 'Harness Member',
    challengeId: captcha?.challengeId ?? '',
    captchaAnswer: captcha?.captchaAnswer ?? '',
  };
  return { ...payload, ...overrides };
}

/** Split every `Set-Cookie` header into its values. */
export function readSetCookies(response: Response): string[] {
  const single = response.headers.get('set-cookie');
  if (!single) return [];
  // `Headers.get` joins multiple values with ", " which also appears inside an
  // `Expires` attribute; the session cookie has no Expires, but be defensive and only
  // split on a comma that starts a new `name=` pair.
  return single.split(/,(?=\s*[A-Za-z0-9_-]+=)/).map((value) => value.trim());
}

/** The `aragon_session` `Set-Cookie` value, or `null`. */
export function sessionSetCookie(response: Response): string | null {
  return readSetCookies(response).find((value) => value.startsWith(`${SESSION_COOKIE}=`)) ?? null;
}

/** `aragon_session` value half of a `Set-Cookie` line (`''` for a cleared cookie). */
export function sessionTokenFromSetCookie(line: string | null): string | null {
  if (!line) return null;
  const pair = line.split(';')[0] ?? '';
  const equals = pair.indexOf('=');
  if (equals < 0) return null;
  return pair.slice(equals + 1);
}

/** Turn a `Set-Cookie` value into a `Cookie` request header. */
export function cookieHeaderFromSetCookie(line: string | null): Record<string, string> {
  const token = sessionTokenFromSetCookie(line);
  if (!token) return {};
  return { cookie: `${SESSION_COOKIE}=${token}` };
}

/** `Cookie` header carrying a freshly minted session for an existing user id. */
export function sessionCookieFor(
  userId: string,
  userAgent = 'vitest-auth',
): Record<string, string> {
  const session = createSession(userId, { userAgent });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

export interface LoginResponseBody {
  data?: { user?: { id: string; username: string; role: string } };
  error?: { message: string };
}

export interface SignedIn {
  response: Response;
  /** `Cookie` header to reuse the session the route just issued. */
  headers: Record<string, string>;
  /** Session token as the browser received it (never logged). */
  token: string | null;
  body: LoginResponseBody;
}

/**
 * Sign in through the real login handler and return everything a follow-up request
 * needs. The handler is passed in rather than imported so this module stays neutral
 * between suites (and so the assertions always run against the response the route
 * actually produced, not a reconstruction).
 */
export async function signIn(
  loginHandler: (request: Request) => Promise<Response>,
  username: string,
  password: string,
  captcha: SolvedCaptcha | null = issueCaptcha(),
): Promise<SignedIn> {
  const response = await loginHandler(
    jsonRequest(`${BASE_URL}/api/auth/login`, { body: loginPayload(username, password, captcha) }),
  );
  const setCookie = sessionSetCookie(response);
  return {
    response,
    headers: cookieHeaderFromSetCookie(setCookie),
    token: sessionTokenFromSetCookie(setCookie),
    body: (await readJson(response)) as SignedIn['body'],
  };
}

/** Re-exported so suites need a single import for the shared setup. */
export { prepareTestEnv, jsonRequest, readJson };
