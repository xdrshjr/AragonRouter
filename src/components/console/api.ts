/**
 * Thin, strictly typed client for the admin API (C3-C8).
 *
 * Every console request goes through here: the UI never talks to SQLite, never
 * imports `src/lib` and never sees anything but the published envelopes.
 * Responsibilities kept in this module so no page repeats them:
 *   - `credentials: 'same-origin'` so the `aragon_session` cookie is sent;
 *   - `cache: 'no-store'` because every admin response is live data;
 *   - turning `{error:{message}}` (C4) into a typed `ApiError`;
 *   - treating a 401 as an expired session rather than as a generic failure, and
 *     raising the `session-expiry` signal so *any* caller - query or mutation -
 *     makes the shell navigate to `/login`.
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
  CreateProviderPayload,
  ProviderPublic,
  ProviderTestResult,
  RequestLogPublic,
  StatsPayload,
  StatsRange,
  UpdateProviderPayload,
} from '@/components/console/types';

/** Base path of the admin contract. */
export const ADMIN_API_BASE = '/api/admin';

/** Cookie name from C3 (the browser owns it; used only for documentation/UI copy). */
export const SESSION_COOKIE_NAME = 'aragon_session';

/** Human-readable text shown when the session is gone. */
export const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again.';

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
  return { data: data as T[], nextCursor: parseNextCursor((payload as { nextCursor?: unknown }).nextCursor) };
}

export interface AdminRequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
  signal?: AbortSignal;
}

/**
 * Perform an admin request and resolve the parsed JSON body.
 * `path` is relative to {@link ADMIN_API_BASE} and may carry a query string.
 */
async function adminRequest(path: string, options: AdminRequestOptions = {}): Promise<unknown> {
  const { method = 'GET', body, signal } = options;
  const headers: Record<string, string> = { accept: 'application/json' };
  if (body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(`${ADMIN_API_BASE}${path}`, {
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

  if (!response.ok) {
    // C3: 401 always means "no/expired session", whatever the body says.
    if (response.status === 401) {
      // Raise the expiry signal here - at the only place where the status is read
      // - so a mutation (POST/PATCH/DELETE) redirects exactly like a query does.
      // Panels no longer have to remember to watch their action error, and a
      // forgotten `useSessionExpiryRedirect` cannot turn an expired session into a
      // button that silently does nothing.
      //
      // `POST /session` is the one exception: a wrong password also answers 401,
      // and the login form must show that inline instead of navigating away.
      if (!(path === '/session' && method === 'POST')) notifySessionExpired();
      throw new ApiError(SESSION_EXPIRED_MESSAGE, 401, 'http');
    }
    throw new ApiError(
      readErrorMessage(parsed.ok ? parsed.value : null, response.status),
      response.status,
      'http',
    );
  }

  if (!parsed.ok) {
    throw new ApiError(
      'The server returned an empty or malformed response.',
      response.status,
      'protocol',
    );
  }
  return parsed.value;
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
