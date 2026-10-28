import { ApiKeyValidationError, findActiveApiKey, touchApiKey } from '@/lib/apikeys';
import { isSecureRequest } from '@/lib/auth';
import { EncryptionError } from '@/lib/crypto';
import { ConfigurationError, getMaxRequestBodyBytes } from '@/lib/env';
import { ProviderValidationError } from '@/lib/providers';
import { authenticateRequest } from '@/lib/sessions';
import { RegistrationClosedError } from '@/lib/settings';
import {
  UserNotFoundError,
  UserRuleError,
  UserValidationError,
} from '@/lib/users';
import type { AuthContext, ClientErrorBody, DataEnvelope, ErrorEnvelope } from '@/lib/types';

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

/** Raw JSON response with the shared headers. */
export function jsonResponse(
  payload: unknown,
  status = 200,
  extraHeaders: Record<string, string> = {},
): Response {
    return new Response(JSON.stringify(payload), {
    status,
    headers: { ...JSON_HEADERS, ...extraHeaders },
  });
}

/** C4 success envelope: `{ data: ... }`. */
export function ok<T>(data: T, status = 200, extraHeaders: Record<string, string> = {}): Response {
  const envelope: DataEnvelope<T> = { data };
  return jsonResponse(envelope, status, extraHeaders);
}

/** C4 failure envelope: `{ error: { message } }`. */
export function fail(message: string, status = 400): Response {
  const envelope: ErrorEnvelope = { error: { message } };
  return jsonResponse(envelope, status);
}

/** C3: every unauthenticated admin request answers exactly this body. */
export function unauthorized(): Response {
  return fail('unauthorized', 401);
}

/**
 * C-GUARD: authenticated but not allowed. Deliberately a different message from
 * `unauthorized` so the client can tell "sign in again" (401 => session-expired
 * signal, redirect to login) from "you may not do this" (403 => stay put).
 */
export function forbidden(): Response {
  return fail('forbidden', 403);
}

export function notFound(message = 'not found'): Response {
  return fail(message, 404);
}

export function serverError(message = 'internal server error'): Response {
  return fail(message, 500);
}

export function methodNotAllowed(allow: readonly string[]): Response {
  return jsonResponse({ error: { message: 'method not allowed' } }, 405, {
    allow: allow.join(', '),
  });
}

/** C2: client-facing (Anthropic compatible) error body. */
export function clientError(message: string, status = 400, type = 'api_error'): Response {
  const body: ClientErrorBody = { type: 'error', error: { type, message } };
  return jsonResponse(body, status);
}

/** C2: the exact 401 body clients expect for a missing/unknown key. */
export function clientAuthenticationError(message = 'invalid x-api-key'): Response {
  return clientError(message, 401, 'authentication_error');
}

/**
 * Legacy one-argument handler shape.
 *
 * Kept exported (it is part of the pre-C-GUARD surface the existing route handlers
 * and any consumer may name) but `withAdmin` no longer accepts it as a union with
 * {@link AuthHandler}: a function with fewer parameters is assignable to one with
 * more, so the old handlers keep compiling without a cast.
 */
export type AdminHandler = (request: Request) => Response | Promise<Response>;

/**
 * Handler that receives the resolved actor as well as the request (C-GUARD).
 *
 * Both guards take this one type: a handler that ignores the actor is still
 * assignable (TypeScript allows fewer parameters), while a handler that *declares*
 * a second parameter is checked against `AuthContext` instead of silently
 * receiving it through a cast.
 */
export type AuthHandler = (request: Request, context: AuthContext) => Response | Promise<Response>;

function describeAuthFailure(error: unknown): void {
  // Never echo the token or the cookie: only that a guard failed.
  const name = error instanceof Error ? error.name : 'unknown';
  console.error('[auth] session resolution failed', name);
}

function resolveActor(request: Request): AuthContext | null {
  try {
    return authenticateRequest(request);
  } catch (error) {
    describeAuthFailure(error);
    return null;
  }
}

/**
 * C-GUARD: admin guard for `/api/admin/**`, same export name and arity as before.
 *
 *  - no/expired/revoked session, or a disabled user -> `401 {error:{message:"unauthorized"}}`
 *  - a live session whose user is a `member`       -> `403 {error:{message:"forbidden"}}`
 *  - an active `admin`                             -> the handler runs
 *
 * The actor is passed as the handler's second argument; the existing one-argument
 * handlers simply ignore it.
 */
export async function withAdmin(
  request: Request,
  handler: AuthHandler,
): Promise<Response> {
  const context = resolveActor(request);
  if (!context) return unauthorized();
  if (context.user.role !== 'admin' || context.user.status !== 'active') return forbidden();
  try {
    return await handler(request, context);
  } catch (error) {
    console.error('[admin] unhandled error', error);
    return serverError('internal server error');
  }
}

/**
 * C-GUARD: require any live session and hand the actor to the handler.
 *
 * Missing/expired/revoked/disabled => `401 {error:{message:'unauthorized'}}`.
 * A `member` is welcome here: role checks belong to `withAdmin`.
 */
export async function withAuth(request: Request, handler: AuthHandler): Promise<Response> {
  const context = resolveActor(request);
  if (!context) return unauthorized();
  try {
    return await handler(request, context);
  } catch (error) {
    console.error('[auth] unhandled error', error);
    return serverError('internal server error');
  }
}

export type ParsedBody =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; status: number };

interface BoundedRead {
  ok: boolean;
  text: string;
  /** Set when the body exceeded the configured limit. */
  overflow: boolean;
  /** Set when the underlying stream failed mid-read. */
  failed: boolean;
}

/**
 * Read a request body with a hard byte budget.
 *
 * `Request.text()` would happily buffer gigabytes: any `ar-...` key holder (the
 * lowest-privilege party in the system) could exhaust the server's memory with a
 * single POST. The declared `content-length` is checked first so an honest client
 * is rejected without any read, and the stream is then read against the same
 * budget because that header is attacker-controlled.
 */
async function readBoundedRequestBody(request: Request, limitBytes: number): Promise<BoundedRead> {
  const declared = Number.parseInt(request.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > limitBytes) {
    return { ok: false, text: '', overflow: true, failed: false };
  }

  const body = request.body;
  if (!body) {
    // No stream (empty body, or a Request built from a string in tests/runtimes
    // without a stream). `text()` cannot grow past what `content-length` claimed.
    try {
      const text = await request.text();
      if (text.length > limitBytes) return { ok: false, text: '', overflow: true, failed: false };
      return { ok: true, text, overflow: false, failed: false };
    } catch {
      return { ok: false, text: '', overflow: false, failed: true };
    }
  }

  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > limitBytes) {
        // Stop reading immediately: the rest of the body is never buffered.
        await reader.cancel().catch(() => undefined);
        return { ok: false, text: '', overflow: true, failed: false };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, text: '', overflow: false, failed: true };
  }

  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { ok: true, text: new TextDecoder().decode(merged), overflow: false, failed: false };
}

/**
 * Parse a JSON object body defensively: bounded size, bad JSON, non-object roots.
 *
 * `status` is 413 for an oversized body and 400 for everything else, so callers can
 * answer with the right envelope without re-checking.
 */
export async function parseJsonBody(
  request: Request,
  limitBytes: number = getMaxRequestBodyBytes(),
): Promise<ParsedBody> {
  const read = await readBoundedRequestBody(request, limitBytes);
  if (read.overflow) {
    return {
      ok: false,
      message: `request body is too large: the limit is ${limitBytes} bytes`,
      status: 413,
    };
  }
  if (!read.ok) {
    return { ok: false, message: 'unable to read the request body', status: 400 };
  }
  const text = read.text;
  if (text.trim().length === 0) {
    return { ok: false, message: 'request body is required', status: 400 };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, message: 'request body must be valid JSON', status: 400 };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, message: 'request body must be a JSON object', status: 400 };
  }
  return { ok: true, body: parsed as Record<string, unknown> };
}

/**
 * Read the client credential from `x-api-key` or `Authorization: Bearer ar-...` (C2).
 * Only `ar-` prefixed values are accepted from the bearer header.
 */
export function extractClientApiKey(request: Request): string | null {
  const header = request.headers.get('x-api-key');
  if (header) {
    const trimmed = header.trim();
    if (trimmed.length > 0) return trimmed;
  }
  const authorization = request.headers.get('authorization');
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match || !match[1]) return null;
  return match[1].trim();
}

/** Session cookie helpers re-exported so routes do not import auth directly. */
export { isSecureRequest };

/** C4 list envelope. `nextCursor` is omitted unless the endpoint paginates. */
export function okList<T>(data: T[], nextCursor?: string | null): Response {
  const payload: { data: T[]; nextCursor?: string | null } = { data };
  if (nextCursor !== undefined) payload.nextCursor = nextCursor;
  return jsonResponse(payload);
}

export type ClientAuthorization =
  | { ok: true; apiKey: { id: string; name: string } }
  | { ok: false; response: Response };

/**
 * C2 client authentication: `x-api-key: ar-...` or `Authorization: Bearer ar-...`.
 * A missing or unknown/revoked key always yields
 * `401 {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key"}}`.
 */
export function authorizeClientRequest(request: Request): ClientAuthorization {
  const presented = extractClientApiKey(request);
  if (!presented) return { ok: false, response: clientAuthenticationError() };
  let apiKey: { id: string; name: string } | null = null;
  try {
    apiKey = findActiveApiKey(presented);
  } catch (error) {
    console.error('[relay] unable to verify the api key:', error);
    return {
      ok: false,
      response: clientError('internal error while verifying the api key', 500, 'api_error'),
    };
  }
  if (!apiKey) return { ok: false, response: clientAuthenticationError() };
  touchApiKey(apiKey.id);
  return { ok: true, apiKey };
}

/**
 * Translate a known domain validation error into an admin error response (C4).
 * Returns `null` for anything unexpected so the caller can rethrow a 500.
 *
 * User errors: `UserValidationError` / `UserRuleError` (400 - the request cannot
 * be honoured as made), `UserNotFoundError` (404), `RegistrationClosedError` (403).
 */
export function mapDomainError(error: unknown): Response | null {
  if (error instanceof ApiKeyValidationError || error instanceof ProviderValidationError) {
    return fail(error.message, 400);
  }
  if (error instanceof UserValidationError || error instanceof UserRuleError) {
    return fail(error.message, 400);
  }
  if (error instanceof UserNotFoundError) {
    return notFound(error.message);
  }
  if (error instanceof RegistrationClosedError) {
    return forbidden();
  }
  if (error instanceof ConfigurationError || error instanceof EncryptionError) {
    // Configuration problems are server-side; the message is actionable but
    // never contains a secret value.
    return fail(error.message, 500);
  }
  return null;
}
