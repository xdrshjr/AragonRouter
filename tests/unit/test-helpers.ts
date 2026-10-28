import { resetDbForTests } from '@/lib/db';
import { SESSION_COOKIE, createSession } from '@/lib/sessions';
import {
  createUser,
  ensureBootstrapAdmin,
  findUserByUsername,
  type CreateUserInput,
} from '@/lib/users';
import type { UserPublic } from '@/lib/types';

/**
 * Shared fixtures for the unit suite.
 *
 * Tests never touch the network (fetch is always stubbed) and never open a real
 * database file: `DATABASE_PATH` is `:memory:` for the whole suite.
 */
export const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
export const TEST_SESSION_SECRET = 'unit-test-session-secret-0123456789abcdef';
export const TEST_ADMIN_PASSWORD = 'unit-test-admin-password';
/** Valid against the password policy and independent of the admin username. */
export const TEST_MEMBER_PASSWORD = 'Unit-Test-Passw0rd';
export const UPSTREAM_ANTHROPIC_KEY = 'sk-ant-upstream-secret-value';
export const UPSTREAM_OPENAI_KEY = 'sk-openai-upstream-secret-value';

/** Install the environment the gateway expects, then start from a clean DB. */
export function prepareTestEnv(): void {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.COOKIE_SECURE;
  resetDbForTests();
}

/**
 * The bootstrap admin row, created on demand.
 *
 * Sessions are database rows now, so every admin fixture needs a real user to
 * hang the session on; `ensureBootstrapAdmin` is the same code path the server
 * runs on its first boot.
 */
export function bootstrapAdmin(): { id: string; username: string; role: string } {
  const admin = ensureBootstrapAdmin();
  return { id: admin.id, username: admin.username, role: admin.role };
}

/**
 * Headers carrying a real admin session cookie.
 *
 * This is the replacement for the old stateless HMAC fixture: the token is a
 * `<sessionId>.<secret>` pair backed by a `user_sessions` row, so any test that
 * exercises `withAdmin` runs through the production authentication path.
 */
export function adminHeaders(): Record<string, string> {
  const admin = bootstrapAdmin();
  const session = createSession(admin.id, { userAgent: 'vitest-admin' });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

/** Create (or reuse) a non-admin account for role tests. */
export function createMemberUser(
  username = 'member-1',
  overrides: Partial<CreateUserInput> = {},
): UserPublic {
  const existing = findUserByUsername(username);
  if (existing) return existing;
  return createUser({
    username,
    password: TEST_MEMBER_PASSWORD,
    role: 'member',
    displayName: 'Test Member',
    ...overrides,
  });
}

/** Mint a session cookie header for any user id (admin or member). */
export function sessionHeadersFor(userId: string, userAgent = 'vitest'): Record<string, string> {
  const session = createSession(userId, { userAgent });
  return { cookie: `${SESSION_COOKIE}=${session.token}` };
}

/** Headers for a signed-in member; creates the account when it does not exist. */
export function memberHeaders(
  user: Pick<UserPublic, 'id'> = createMemberUser(),
): Record<string, string> {
  return sessionHeadersFor(user.id, 'vitest-member');
}

export interface JsonRequestInit {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Build a JSON `Request` the way an HTTP client would. */
export function jsonRequest(url: string, init: JsonRequestInit = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  return new Request(url, { method: init.method ?? 'POST', headers, body });
}

/** Reader helper: drain a Response body into a single string. */
export async function readBody(response: Response): Promise<string> {
  return response.text();
}

/** Reader helper: drain a Response body into JSON with a useful failure message. */
export async function readJson<T = unknown>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`expected JSON, received: ${text.slice(0, 200)}`);
  }
}

/** Route context for `/api/admin/**\/[id]` handlers in Next 15. */
export function routeContext<T extends Record<string, string>>(params: T): { params: Promise<T> } {
  return { params: Promise.resolve(params) };
}

/** Build a `Response` whose body is delivered as the given chunks. */
export function chunkedResponse(
  chunks: string[],
  init: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
  return new Response(body, {
    status: init.status ?? 200,
    headers: { 'content-type': 'text/event-stream', ...(init.headers ?? {}) },
  });
}
