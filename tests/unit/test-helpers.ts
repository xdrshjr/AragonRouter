import { SESSION_COOKIE, createSessionToken } from '@/lib/auth';
import { resetDbForTests } from '@/lib/db';

/**
 * Shared fixtures for the unit suite.
 *
 * Tests never touch the network (fetch is always stubbed) and never open a real
 * database file: `DATABASE_PATH` is `:memory:` for the whole suite.
 */
export const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
export const TEST_SESSION_SECRET = 'unit-test-session-secret-0123456789abcdef';
export const TEST_ADMIN_PASSWORD = 'unit-test-admin-password';
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

/** Headers carrying a valid admin session cookie. */
export function adminHeaders(): Record<string, string> {
  return { cookie: `${SESSION_COOKIE}=${createSessionToken()}` };
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
