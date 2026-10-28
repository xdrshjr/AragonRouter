/**
 * Thin, strictly typed client for the console HTTP contracts.
 *
 * Every console request goes through here: the UI never talks to SQLite, never
 * imports `src/lib` and never sees anything but the published envelopes.
 * Responsibilities kept in this module so no page repeats them:
 *   - `credentials: 'same-origin'` so the `aragon_session` cookie is sent;
 *   - `cache: 'no-store'` because every response is live data;
 *   - turning `{error:{message}}` (C4) into a typed `ApiError`;
 *   - treating a `/api/admin/**` 401 as an expired session (raising the
 *     `session-expiry` signal, which the shell answers by returning to the guest
 *     view and opening the sign-in dialog) while a `/api/auth/**` 401 stays a
 *     plain credential failure the form shows inline.
 *
 * Two surfaces live here:
 *   - `/api/auth/**`      (C-AUTH-WIRE / C-CAPTCHA) - guests may call it;
 *   - `/api/admin/**`     (C3-C8, C-USERS-WIRE, C-SETTINGS-WIRE) - administrators.
 */

import {
  buildLogsQuery,
  buildStatsQuery,
  parseNextCursor,
  type LogsQueryInput,
} from '@/components/console/log-query';
import { notifySessionExpired } from '@/components/console/session-expiry';
import type {
  ApiKeyCreated,
  ApiKeyPublic,
  AuthStatePayload,
  CaptchaChallengePublic,
  ChangePasswordInput,
  CreateProviderPayload,
  CreateUserPayload,
  ListUsersInput,
  LoginInput,
  ProviderPublic,
  ProviderTestResult,
  RegisterInput,
  RegistrationSetting,
  RequestLogPublic,
  StatsPayload,
  StatsRange,
  UpdateProviderPayload,
  UpdateUserPayload,
  UserDetailPublic,
  UserPublic,
  UsersPage,
} from '@/components/console/types';

/** Base path of the admin contract. */
export const ADMIN_API_BASE = '/api/admin';

/** Base path of the guest-reachable account contract (C-AUTH-WIRE). */
export const AUTH_API_BASE = '/api/auth';

/** Cookie name from C3 (the browser owns it; used only for documentation/UI copy). */
export const SESSION_COOKIE_NAME = 'aragon_session';

/** Human-readable text shown when the session is gone. */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again.';

/**
 * What the console shows a signed-in `member` who reached an admin-only surface.
 *
 * The transport keeps the server's own word for a 403 (`forbidden`) because the
 * gateway contract tests pin it; translating it into operator copy is this layer's
 * job, and every screen that can show a 403 goes through
 * {@link describeApiFailure} or renders this constant itself.
 */
export const ADMIN_REQUIRED_MESSAGE =
  'Administrator access required. Ask an administrator to grant your account the admin role.';

export type ApiErrorKind = 'network' | 'http' | 'protocol';

/** Every failure surfaced by this module is an `ApiError`. */
export class ApiError extends Error {
  /** HTTP status, or 0 when the request never completed. */
  readonly status: number;
  readonly kind: ApiErrorKind;

  constructor(message: string, status = 0, kind: ApiErrorKind = 'http') {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.kind = kind;
  }
}

/** True when the failure is an authentication failure (C3 401). */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiError && error.status === 401;
}

/** True when the caller is signed in but not allowed (C-GUARD 403). */
export function isForbidden(error: unknown): boolean {
  return error instanceof ApiError && error.status === 403;
}

/**
 * Operator-facing text for a failed request.
 *
 * A 403 is the only status whose server wording (`forbidden`) is an API token
 * rather than human copy, so it is translated here; everything else keeps the
 * message the transport already normalised (truncated, never empty).
 */
export function describeApiFailure(error: unknown): string {
  if (isForbidden(error)) return ADMIN_REQUIRED_MESSAGE;
  if (error instanceof Error && error.message.trim().length > 0) return error.message;
  return 'The request failed.';
}

/** True when the user aborted the request (component unmounted, filter changed). */
export function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

/** Every message rendered in the UI is capped, whatever the server sends. */
const MAX_MESSAGE_LENGTH = 400;

function truncateMessage(message: string): string {
  const collapsed = message.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= MAX_MESSAGE_LENGTH) return collapsed;
  return `${collapsed.slice(0, MAX_MESSAGE_LENGTH - 1)}…`;
}

/**
 * Extract a readable message from a C4 failure envelope.
 * Tolerates shape drift (`{error: 'text'}`, `{message}`) and never returns an
 * empty string, so the UI can always show something actionable.
 */
export function readErrorMessage(payload: unknown, status = 0): string {
  if (payload !== null && typeof payload === 'object') {
    const record = payload as Record<string, unknown>;
    const error = record.error;
    if (typeof error === 'string' && error.trim().length > 0) return truncateMessage(error);
    if (error !== null && typeof error === 'object') {
      const message = (error as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim().length > 0) return truncateMessage(message);
    }
    const direct = record.message;
    if (typeof direct === 'string' && direct.trim().length > 0) return truncateMessage(direct);
  }
  if (status >= 500) return 'The server reported an internal error. Check the server output.';
  if (status > 0) return `The request failed with HTTP ${status}.`;
  return 'The request failed.';
}

export interface ParsedBody {
  ok: boolean;
  value?: unknown;
}

/**
 * Parse a response body without ever throwing.
 * An empty body is reported as `ok: false`: every admin endpoint returns JSON,
 * so an empty 200 means a proxy or a crashed handler mangled the response.
 */
export function parseJsonBody(text: string): ParsedBody {
  if (text.trim().length === 0) return { ok: false };
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false };
  }
}

/** Read `data` out of a C4 success envelope. */
export function unwrapData<T>(payload: unknown): T {
  if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError('The server returned an unexpected response shape.', 0, 'protocol');
  }
  return (payload as { data: T }).data;
}

/** Read `{data, nextCursor}` out of a C4 list envelope. */
export function unwrapList<T>(payload: unknown): { data: T[]; nextCursor: string | null } {
  if (payload === null || typeof payload !== 'object' || !('data' in payload)) {
    throw new ApiError('The server returned an unexpected response shape.', 0, 'protocol');
  }
  const data = (payload as { data: unknown }).data;
  if (!Array.isArray(data)) {
    throw new ApiError('The server returned a list where an object was expected.', 0, 'protocol');
  }
  const cursor = parseNextCursor((payload as { nextCursor?: unknown }).nextCursor);
  return { data: data as T[], nextCursor: cursor };
}

export interface AdminRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/** Which published surface a request targets; the base path and 401 policy follow it. */
type RequestScope = 'admin' | 'auth';

/**
 * Turn a failed response into the typed error this module promises.
 *
 * The 401 policy is the whole reason the scope is threaded through:
 *  - `/api/admin/**`: "your session is gone". The signal is raised here - at the
 *    only place where the status is read - so a mutation (POST/PATCH/DELETE)
 *    re-runs the shell's expiry handling exactly like a query does. `POST /session`
 *    is the one exception: a wrong password also answers 401, and the login form
 *    must show that inline.
 *  - `/api/auth/**`: a 401 means "wrong credentials", never "session expired", and
 *    raising the signal there would reopen the dialog the visitor is already using.
 */
function buildFailure(
  scope: RequestScope,
  path: string,
  method: string,
  status: number,
  parsed: ParsedBody,
): ApiError {
  const body = parsed.ok ? parsed.value : null;
  if (status === 401) {
    if (scope === 'auth') return new ApiError(readErrorMessage(body, 401), 401, 'http');
    if (!(path === '/session' && method === 'POST')) notifySessionExpired();
    return new ApiError(SESSION_EXPIRED_MESSAGE, 401, 'http');
  }
  return new ApiError(readErrorMessage(body, status), status, 'http');
}

/**
 * Perform one request and resolve the parsed JSON body.
 * `path` is relative to the scope's base and may carry a query string.
 */
async function sendRequest(
  scope: RequestScope,
  path: string,
  options: AdminRequestOptions = {},
): Promise<unknown> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';
  const base = scope === 'admin' ? ADMIN_API_BASE : AUTH_API_BASE;

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      // C3: the session lives in an HttpOnly cookie, so it must ride along.
      credentials: 'same-origin',
      cache: 'no-store',
      signal,
    });
  } catch (error) {
    if (isAbortError(error)) throw error;
    throw new ApiError(
      'Unable to reach the console API. Check that the server is running.',
      0,
      'network',
    );
  }

  let text = '';
  try {
    text = await response.text();
  } catch {
    text = '';
  }
  const parsed = parseJsonBody(text);

  if (!response.ok) throw buildFailure(scope, path, method, response.status, parsed);

  if (!parsed.ok) {
    throw new ApiError(
      'The server returned an empty or malformed response.',
      response.status,
      'protocol',
    );
  }
  return parsed.value;
}

/** Perform an administrator request; a 401 raises the session-expiry signal. */
async function adminRequest(path: string, options: AdminRequestOptions = {}): Promise<unknown> {
  return sendRequest('admin', path, options);
}

/**
 * Perform an account request (C-AUTH-WIRE). Guests call these, so a 401 is a
 * credential failure rather than an expired session.
 */
async function authRequest(path: string, options: AdminRequestOptions = {}): Promise<unknown> {
  return sendRequest('auth', path, options);
}

/* -------------------------------------------------------------------------- */
/* C3 - admin session                                                         */
/* -------------------------------------------------------------------------- */

/** Validate the current cookie. Resolves on success, throws `ApiError(401)` otherwise. */
export async function getSession(signal?: AbortSignal): Promise<boolean> {
  const payload = await adminRequest('/session', { signal });
  const data = unwrapData<{ ok?: unknown }>(payload);
  return data !== null && typeof data === 'object' && data.ok === true;
}

/** Exchange the admin password for a session cookie. */
export async function signIn(password: string, signal?: AbortSignal): Promise<void> {
  await adminRequest('/session', { method: 'POST', body: { password }, signal });
}

/** Clear the session cookie. */
export async function signOut(): Promise<void> {
  await adminRequest('/session', { method: 'DELETE' });
}

/* -------------------------------------------------------------------------- */
/* C5 - API keys                                                              */
/* -------------------------------------------------------------------------- */

export async function listKeys(signal?: AbortSignal): Promise<ApiKeyPublic[]> {
  const payload = await adminRequest('/keys', { signal });
  return unwrapList<ApiKeyPublic>(payload).data;
}

/** Create a key; the plaintext `key` in the response is the only chance to copy it. */
export async function createKey(name: string, signal?: AbortSignal): Promise<ApiKeyCreated> {
  const payload = await adminRequest('/keys', { method: 'POST', body: { name }, signal });
  return unwrapData<ApiKeyCreated>(payload);
}

/** Soft-revoke a key. Resolves with the id the server confirmed. */
export async function revokeKey(id: string, signal?: AbortSignal): Promise<string> {
  const payload = await adminRequest(`/keys/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
  return unwrapData<{ id: string }>(payload).id;
}

/* -------------------------------------------------------------------------- */
/* C6 - providers                                                             */
/* -------------------------------------------------------------------------- */

export async function listProviders(signal?: AbortSignal): Promise<ProviderPublic[]> {
  const payload = await adminRequest('/providers', { signal });
  return unwrapList<ProviderPublic>(payload).data;
}

export async function createProvider(
  input: CreateProviderPayload,
  signal?: AbortSignal,
): Promise<ProviderPublic> {
  const payload = await adminRequest('/providers', { method: 'POST', body: input, signal });
  return unwrapData<ProviderPublic>(payload);
}

export async function updateProvider(
  id: string,
  patch: UpdateProviderPayload,
  signal?: AbortSignal,
): Promise<ProviderPublic> {
  const payload = await adminRequest(`/providers/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
    signal,
  });
  return unwrapData<ProviderPublic>(payload);
}

export async function deleteProvider(id: string, signal?: AbortSignal): Promise<string> {
  const payload = await adminRequest(`/providers/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    signal,
  });
  return unwrapData<{ id: string }>(payload).id;
}

/** Probe `{baseUrl}/v1/models` through the gateway (5s budget, key never echoed). */
export async function testProvider(id: string, signal?: AbortSignal): Promise<ProviderTestResult> {
  const payload = await adminRequest(`/providers/${encodeURIComponent(id)}/test`, {
    method: 'POST',
    signal,
  });
  const data = unwrapData<Partial<ProviderTestResult>>(payload);
  return {
    ok: data?.ok === true,
    message:
      typeof data?.message === 'string' && data.message.trim().length > 0
        ? data.message
        : 'The provider test returned no message.',
  };
}

/* -------------------------------------------------------------------------- */
/* C7 - statistics                                                            */
/* -------------------------------------------------------------------------- */

export async function getStats(range: StatsRange, signal?: AbortSignal): Promise<StatsPayload> {
  const payload = await adminRequest(`/stats${buildStatsQuery(range)}`, { signal });
  return unwrapData<StatsPayload>(payload);
}

/* -------------------------------------------------------------------------- */
/* C8 - request logs                                                          */
/* -------------------------------------------------------------------------- */

export async function listLogs(
  input: LogsQueryInput,
  signal?: AbortSignal,
): Promise<{ data: RequestLogPublic[]; nextCursor: string | null }> {
  const payload = await adminRequest(`/logs${buildLogsQuery(input)}`, { signal });
  return unwrapList<RequestLogPublic>(payload);
}

/* -------------------------------------------------------------------------- */
/* C-AUTH-WIRE / C-CAPTCHA - accounts (guest reachable)                       */
/* -------------------------------------------------------------------------- */

/** The captcha answer travels in the same body as the credentials; cap its length. */
const MAX_CAPTCHA_ANSWER_LENGTH = 16;

/** Validate the shape of a `UserPublic` before the shell trusts it for identity. */
function normalizeUser(raw: unknown): UserPublic | null {
  if (raw === null || raw === undefined) return null;
  if (typeof raw !== 'object') {
    throw new ApiError('The server returned an unexpected user shape.', 0, 'protocol');
  }
  const record = raw as Record<string, unknown>;
  const role = record.role;
  if (typeof record.id !== 'string' || typeof record.username !== 'string') {
    throw new ApiError('The server returned an unexpected user shape.', 0, 'protocol');
  }
  if (role !== 'admin' && role !== 'member') {
    throw new ApiError('The server returned an unexpected user shape.', 0, 'protocol');
  }
  return raw as UserPublic;
}

/**
 * C-AUTH-WIRE: read the console's identity.
 *
 * Answers for guests too (`user: null`), which is why the shell can render for
 * everybody. `registration.enabled` rides along because the sign-in dialog needs
 * it before anybody is signed in and must not call the admin-only settings route.
 */
export async function fetchAuthState(signal?: AbortSignal): Promise<AuthStatePayload> {
  const payload = await authRequest('/session', { signal });
  const data = unwrapData<{ user?: unknown; registration?: { enabled?: unknown } }>(payload);
  if (data === null || typeof data !== 'object') {
    throw new ApiError('The server returned an unexpected session shape.', 0, 'protocol');
  }
  return {
    user: normalizeUser(data.user),
    registration: { enabled: data.registration?.enabled === true },
  };
}

/** C-CAPTCHA: mint a challenge. The answer lives only inside the returned image. */
export async function fetchCaptcha(signal?: AbortSignal): Promise<CaptchaChallengePublic> {
  const payload = await authRequest('/captcha', { signal });
  const data = unwrapData<Partial<CaptchaChallengePublic>>(payload);
  if (
    typeof data?.challengeId !== 'string' ||
    data.challengeId.length === 0 ||
    typeof data.imageDataUrl !== 'string' ||
    !data.imageDataUrl.startsWith('data:image/svg+xml')
  ) {
    throw new ApiError('The server returned an unusable captcha challenge.', 0, 'protocol');
  }
  return {
    challengeId: data.challengeId,
    imageDataUrl: data.imageDataUrl,
    expiresAt: typeof data.expiresAt === 'string' ? data.expiresAt : '',
  };
}

/** C-AUTH-WIRE: `POST /api/auth/login` - username, password and one captcha. */
export async function login(input: LoginInput, signal?: AbortSignal): Promise<UserPublic> {
  const body = buildCredentialBody(input);
  const payload = await authRequest('/login', { method: 'POST', body, signal });
  const user = normalizeUser(unwrapData<{ user?: unknown }>(payload)?.user);
  if (!user) {
    throw new ApiError('The server accepted the sign-in but sent no account.', 0, 'protocol');
  }
  return user;
}

/** C-AUTH-WIRE: `POST /api/auth/register` - creates a `member` and signs it in. */
export async function register(input: RegisterInput, signal?: AbortSignal): Promise<UserPublic> {
  const body = buildCredentialBody(input);
  const displayName = typeof input.displayName === 'string' ? input.displayName.trim() : '';
  if (displayName.length > 0) body.displayName = displayName;
  const payload = await authRequest('/register', { method: 'POST', body, signal });
  const user = normalizeUser(unwrapData<{ user?: unknown }>(payload)?.user);
  if (!user) {
    throw new ApiError('The account was created but no account was returned.', 0, 'protocol');
  }
  return user;
}

/** Shared body builder: the answer is normalised the way the server compares it. */
function buildCredentialBody(input: LoginInput | RegisterInput): Record<string, unknown> {
  const captchaAnswer = input.captchaAnswer
    .trim()
    .toUpperCase()
    .slice(0, MAX_CAPTCHA_ANSWER_LENGTH);
  return {
    username: input.username.trim(),
    password: input.password,
    challengeId: input.challengeId.trim(),
    captchaAnswer,
  };
}

/** C-AUTH-WIRE: `POST /api/auth/logout` - revokes the row and clears the cookie. */
export async function logout(signal?: AbortSignal): Promise<void> {
  await authRequest('/logout', { method: 'POST', signal });
}

/** C-AUTH-WIRE: `POST /api/auth/password` - authenticated by the session cookie. */
export async function changePassword(
  input: ChangePasswordInput,
  signal?: AbortSignal,
): Promise<void> {
  const body = { currentPassword: input.currentPassword, newPassword: input.newPassword };
  await authRequest('/password', { method: 'POST', body, signal });
}

/* -------------------------------------------------------------------------- */
/* C-USERS-WIRE - administrator account management                            */
/* -------------------------------------------------------------------------- */

/** Build the `GET /api/admin/users` query string (empty filters are omitted). */
export function buildUsersQuery(input: ListUsersInput = {}): string {
  const params = new URLSearchParams();
  if (typeof input.limit === 'number' && Number.isFinite(input.limit) && input.limit > 0) {
    params.set('limit', String(Math.trunc(input.limit)));
  }
  if (typeof input.cursor === 'string' && input.cursor.length > 0) {
    params.set('cursor', input.cursor);
  }
  const search = typeof input.search === 'string' ? input.search.trim() : '';
  if (search.length > 0) params.set('search', search);
  if (input.role) params.set('role', input.role);
  if (input.status) params.set('status', input.status);
  const query = params.toString();
  return query.length > 0 ? `?${query}` : '';
}

/** C-USERS-WIRE: one keyset page of accounts, newest first. */
export async function listUsers(
  input: ListUsersInput = {},
  signal?: AbortSignal,
): Promise<UsersPage> {
  const payload = await adminRequest(`/users${buildUsersQuery(input)}`, { signal });
  return unwrapList<UserPublic>(payload);
}

/** C-USERS-WIRE: create an account (201). */
export async function createUser(
  input: CreateUserPayload,
  signal?: AbortSignal,
): Promise<UserPublic> {
  const payload = await adminRequest('/users', { method: 'POST', body: input, signal });
  return unwrapData<UserPublic>(payload);
}

/** C-USERS-WIRE: one account with its live sessions. */
export async function getUser(id: string, signal?: AbortSignal): Promise<UserDetailPublic> {
  const payload = await adminRequest(`/users/${encodeURIComponent(id)}`, { signal });
  return unwrapData<UserDetailPublic>(payload);
}

/** C-USERS-WIRE: partial update of `displayName` / `role` / `status`. */
export async function updateUser(
  id: string,
  input: UpdateUserPayload,
  signal?: AbortSignal,
): Promise<UserPublic> {
  const payload = await adminRequest(`/users/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: input,
    signal,
  });
  return unwrapData<UserPublic>(payload);
}

/** C-USERS-WIRE: delete an account (its sessions cascade). */
export async function deleteUser(id: string, signal?: AbortSignal): Promise<void> {
  await adminRequest(`/users/${encodeURIComponent(id)}`, { method: 'DELETE', signal });
}

/** C-USERS-WIRE: administrator password reset; revokes the target's other sessions. */
export async function resetUserPassword(
  id: string,
  password: string,
  signal?: AbortSignal,
): Promise<void> {
  await adminRequest(`/users/${encodeURIComponent(id)}/password`, {
    method: 'POST',
    body: { password },
    signal,
  });
}

/** C-USERS-WIRE: revoke one device session of one account. */
export async function revokeUserSession(
  userId: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<void> {
  await adminRequest(
    `/users/${encodeURIComponent(userId)}/sessions/${encodeURIComponent(sessionId)}`,
    { method: 'DELETE', signal },
  );
}

/* -------------------------------------------------------------------------- */
/* C-SETTINGS-WIRE - registration switch                                      */
/* -------------------------------------------------------------------------- */

/** Read `{registration:{enabled}}`. */
export async function getSettings(signal?: AbortSignal): Promise<RegistrationSetting> {
  const payload = await adminRequest('/settings', { signal });
  return readRegistration(unwrapData<{ registration?: { enabled?: unknown } }>(payload));
}

/**
 * Write the registration switch.
 *
 * The caller passes the plain setting (`{enabled}`); the wire shape
 * `{registration:{enabled}}` is built here so no page has to remember it.
 */
export async function updateSettings(input: { enabled: boolean }): Promise<RegistrationSetting> {
  const payload = await adminRequest('/settings', {
    method: 'PATCH',
    body: { registration: { enabled: input.enabled === true } },
  });
  return readRegistration(unwrapData<{ registration?: { enabled?: unknown } }>(payload));
}

/** The settings envelope always carries a boolean; anything else is a protocol fault. */
function readRegistration(data: { registration?: { enabled?: unknown } }): RegistrationSetting {
  const enabled = data?.registration?.enabled;
  if (typeof enabled !== 'boolean') {
    throw new ApiError('The server returned an unexpected settings shape.', 0, 'protocol');
  }
  return { enabled };
}
