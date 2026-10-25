import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ADMIN_API_BASE,
  ApiError,
  SESSION_EXPIRED_MESSAGE,
  createKey,
  createProvider,
  deleteProvider,
  getSession,
  getStats,
  isAbortError,
  isUnauthorized,
  listKeys,
  listLogs,
  listProviders,
  parseJsonBody,
  readErrorMessage,
  revokeKey,
  signIn,
  signOut,
  testProvider,
  unwrapData,
  unwrapList,
  updateProvider,
} from '@/components/console/api';

/**
 * Contract tests for the console API client (C3-C8).
 *
 * `fetch` is replaced with a recorder so every assertion checks the exact URL,
 * method, credentials mode and body the console sends, and the exact envelope
 * handling it performs on the way back.
 */

interface Recorded {
  url: string;
  init: RequestInit | undefined;
}

const calls: Recorded[] = [];

function respondWith(body: unknown, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      const text = typeof body === 'string' ? body : JSON.stringify(body);
      return new Response(text, { status, headers: { 'content-type': 'application/json' } });
    }),
  );
}

function respondWithStatus(status: number, body: unknown = {}): void {
  respondWith(body, status);
}

const KEY_ROW = {
  id: 'key-1',
  name: 'Production',
  keyPrefix: 'ar-0123456',
  createdAt: '2025-01-01T00:00:00.000Z',
  lastUsedAt: null,
  revokedAt: null,
};

const PROVIDER_ROW = {
  id: 'prov-1',
  name: 'Anthropic',
  protocol: 'anthropic',
  baseUrl: 'https://api.anthropic.com',
  enabled: true,
  maskedKey: 'sk-a…z9',
  createdAt: '2025-01-01T00:00:00.000Z',
};

const LOG_ROW = {
  id: 'log-1',
  createdAt: '2025-01-01T00:00:00.000Z',
  protocol: 'anthropic',
  path: '/v1/messages',
  model: 'claude-sonnet-4-5',
  upstream: 'https://api.anthropic.com',
  status: 200,
  latencyMs: 120,
  inputTokens: 12,
  outputTokens: 34,
  apiKeyId: 'key-1',
  error: null,
  stream: false,
};

beforeEach(() => {
  calls.length = 0;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('request plumbing', () => {
  it('sends the session cookie and bypasses caches on every call', async () => {
    respondWith({ data: [] });
    await listKeys();
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call?.url).toBe(`${ADMIN_API_BASE}/keys`);
    expect(call?.init?.method).toBe('GET');
    expect(call?.init?.credentials).toBe('same-origin');
    expect(call?.init?.cache).toBe('no-store');
    expect((call?.init?.headers as Record<string, string>).accept).toBe('application/json');
  });

  it('only sets a JSON content type when a body is sent', async () => {
    respondWith({ data: { ok: true } });
    await getSession();
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBeUndefined();

    respondWith({ data: { ok: true } });
    calls.length = 0;
    await signIn('secret');
    expect((calls[0]?.init?.headers as Record<string, string>)['content-type']).toBe('application/json');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ password: 'secret' }));
  });
});

describe('C3 session', () => {
  it('reveals nothing about the password on failure', async () => {
    respondWithStatus(401, { error: { message: 'unauthorized' } });
    const failure = await signIn('wrong').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect(isUnauthorized(failure)).toBe(true);
    expect((failure as ApiError).status).toBe(401);
    // C3: a 401 is always surfaced as an expired session, never as a password echo.
    expect((failure as ApiError).message).toBe(SESSION_EXPIRED_MESSAGE);
  });

  it('reports a valid cookie as authenticated', async () => {
    respondWith({ data: { ok: true } });
    await expect(getSession()).resolves.toBe(true);
  });

  it('deletes the cookie on sign out', async () => {
    respondWith({ data: { ok: true } });
    await signOut();
    expect(calls[0]?.init?.method).toBe('DELETE');
    expect(calls[0]?.url).toBe(`${ADMIN_API_BASE}/session`);
  });

  it('preserves the server message for a throttled login (429)', async () => {
    respondWithStatus(429, { error: { message: 'too many failed login attempts, try again in a minute' } });
    const failure = await signIn('x').catch((error: unknown) => error);
    expect((failure as ApiError).status).toBe(429);
    expect((failure as ApiError).message).toContain('too many failed login attempts');
  });
});

describe('C5 keys', () => {
  it('unwraps the list envelope', async () => {
    respondWith({ data: [KEY_ROW] });
    const keys = await listKeys();
    expect(keys).toHaveLength(1);
    expect(keys[0]?.keyPrefix).toBe('ar-0123456');
  });

  it('returns the plaintext key from the creation response', async () => {
    respondWith({ data: { ...KEY_ROW, key: 'ar-0123456789abcdef0123456789abcdef' } }, 200);
    const created = await createKey('Production');
    expect(created.key).toBe('ar-0123456789abcdef0123456789abcdef');
    expect(calls[0]?.init?.method).toBe('POST');
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ name: 'Production' }));
  });

  it('encodes the id and returns the confirmed revocation', async () => {
    respondWith({ data: { id: 'key/1 with space' } });
    await expect(revokeKey('key/1 with space')).resolves.toBe('key/1 with space');
    expect(calls[0]?.url).toBe(`${ADMIN_API_BASE}/keys/key%2F1%20with%20space`);
    expect(calls[0]?.init?.method).toBe('DELETE');
  });
});

describe('C6 providers', () => {
  it('lists providers with masked keys only', async () => {
    respondWith({ data: [PROVIDER_ROW] });
    const providers = await listProviders();
    expect(providers[0]?.maskedKey).toBe('sk-a…z9');
    expect(JSON.stringify(providers)).not.toContain('sk-ant-');
  });

  it('creates a provider with the full payload', async () => {
    respondWith({ data: PROVIDER_ROW });
    await createProvider({
      name: 'Anthropic',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: 'sk-ant-secret',
      enabled: true,
    });
    expect(calls[0]?.init?.method).toBe('POST');
    const body = JSON.parse(String(calls[0]?.init?.body)) as Record<string, unknown>;
    expect(body.protocol).toBe('anthropic');
    expect(body.enabled).toBe(true);
  });

  it('patches only the supplied fields', async () => {
    respondWith({ data: { ...PROVIDER_ROW, enabled: false } });
    await updateProvider('prov-1', { enabled: false });
    expect(calls[0]?.init?.method).toBe('PATCH');
    expect(calls[0]?.url).toBe(`${ADMIN_API_BASE}/providers/prov-1`);
    expect(JSON.parse(String(calls[0]?.init?.body))).toEqual({ enabled: false });
  });

  it('deletes a provider and returns its id', async () => {
    respondWith({ data: { id: 'prov-1' } });
    await expect(deleteProvider('prov-1')).resolves.toBe('prov-1');
    expect(calls[0]?.init?.method).toBe('DELETE');
  });

  it('posts to the test endpoint and normalises the result', async () => {
    respondWith({ data: { ok: false, message: 'upstream responded 401 Unauthorized' } });
    await expect(testProvider('prov-1')).resolves.toEqual({
      ok: false,
      message: 'upstream responded 401 Unauthorized',
    });
    expect(calls[0]?.url).toBe(`${ADMIN_API_BASE}/providers/prov-1/test`);
    expect(calls[0]?.init?.method).toBe('POST');
  });

  it('always returns a message for the connectivity probe', async () => {
    respondWith({ data: { ok: true } });
    const result = await testProvider('prov-1');
    expect(result.ok).toBe(true);
    expect(result.message.length).toBeGreaterThan(0);
  });
});

describe('C7 stats', () => {
  it('asks for the requested range', async () => {
    respondWith({
      data: {
        range: '24h',
        totals: { requests: 4, inputTokens: 10, outputTokens: 20, errorRate: 0.25, avgLatencyMs: 90 },
        series: [],
        byModel: [],
        byKey: [],
      },
    });
    const stats = await getStats('24h');
    expect(calls[0]?.url).toBe(`${ADMIN_API_BASE}/stats?range=24h`);
    expect(stats.totals.requests).toBe(4);
    expect(stats.range).toBe('24h');
  });
});

describe('C8 logs', () => {
  it('sends limit, status, model and the encoded cursor', async () => {
    respondWith({ data: [LOG_ROW], nextCursor: '1700000000000|log-1' });
    const page = await listLogs({ limit: 50, status: '200', model: 'claude-sonnet-4-5', cursor: '1|a' });
    const url = new URL(`http://localhost${calls[0]?.url ?? ''}`);
    expect(url.pathname).toBe(`${ADMIN_API_BASE}/logs`);
    expect(url.searchParams.get('limit')).toBe('50');
    expect(url.searchParams.get('status')).toBe('200');
    expect(url.searchParams.get('model')).toBe('claude-sonnet-4-5');
    expect(url.searchParams.get('cursor')).toBe('1|a');
    expect(page.nextCursor).toBe('1700000000000|log-1');
    expect(page.data[0]?.status).toBe(200);
  });

  it('treats a missing nextCursor as the end of the log', async () => {
    respondWith({ data: [LOG_ROW] });
    await expect(listLogs({ limit: 50 })).resolves.toEqual({ data: [LOG_ROW], nextCursor: null });
  });

  it('treats an empty nextCursor as the end of the log', async () => {
    respondWith({ data: [], nextCursor: '' });
    await expect(listLogs({})).resolves.toEqual({ data: [], nextCursor: null });
  });
});

describe('failure handling', () => {
  it('keeps the C4 error message', async () => {
    respondWithStatus(400, { error: { message: 'name must not be empty' } });
    const failure = await createKey('').catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(400);
    expect((failure as ApiError).message).toBe('name must not be empty');
  });

  it('reports a transport failure as a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const failure = await listKeys().catch((error: unknown) => error);
    expect((failure as ApiError).kind).toBe('network');
    expect((failure as ApiError).status).toBe(0);
    expect((failure as ApiError).message).toContain('Unable to reach');
  });

  it('rethrows an abort so callers can ignore it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new DOMException('aborted', 'AbortError');
      }),
    );
    const failure = await listKeys().catch((error: unknown) => error);
    expect(isAbortError(failure)).toBe(true);
  });

  it('rejects an empty or malformed success body', async () => {
    respondWith('');
    const emptyFailure = await listKeys().catch((error: unknown) => error);
    expect((emptyFailure as ApiError).kind).toBe('protocol');

    respondWith('<html>proxy error</html>');
    const htmlFailure = await listKeys().catch((error: unknown) => error);
    expect((htmlFailure as ApiError).kind).toBe('protocol');
  });

  it('rejects a success body without a data field', async () => {
    respondWith({ ok: true });
    const failure = await listKeys().catch((error: unknown) => error);
    expect((failure as ApiError).kind).toBe('protocol');
  });

  it('rejects a list envelope whose data is not an array', async () => {
    respondWith({ data: { id: 'x' } });
    const failure = await listProviders().catch((error: unknown) => error);
    expect((failure as ApiError).kind).toBe('protocol');
    expect((failure as ApiError).message).toContain('list');
  });
});

describe('envelope helpers', () => {
  it('reads a message from every tolerated error shape', () => {
    expect(readErrorMessage({ error: { message: 'boom' } })).toBe('boom');
    expect(readErrorMessage({ error: 'plain' })).toBe('plain');
    expect(readErrorMessage({ message: 'direct' })).toBe('direct');
    expect(readErrorMessage(null, 500)).toContain('internal error');
    expect(readErrorMessage(null, 418)).toContain('418');
    expect(readErrorMessage({})).toBe('The request failed.');
    expect(readErrorMessage({ error: { message: '   ' } })).toBe('The request failed.');
  });

  it('collapses and truncates a hostile message', () => {
    const noisy = `a${' '.repeat(50)}b`;
    expect(readErrorMessage({ error: { message: noisy } })).toBe('a b');
    const long = readErrorMessage({ error: { message: 'x'.repeat(1000) } });
    expect(long.length).toBeLessThanOrEqual(400);
    expect(long.endsWith('…')).toBe(true);
  });

  it('parses JSON defensively', () => {
    expect(parseJsonBody('{"a":1}')).toEqual({ ok: true, value: { a: 1 } });
    expect(parseJsonBody('')).toEqual({ ok: false });
    expect(parseJsonBody('   ')).toEqual({ ok: false });
    expect(parseJsonBody('{')).toEqual({ ok: false });
    expect(parseJsonBody('null')).toEqual({ ok: true, value: null });
  });

  it('unwraps data and throws a protocol error otherwise', () => {
    expect(unwrapData<number>({ data: 7 })).toBe(7);
    expect(() => unwrapData(null)).toThrow(ApiError);
    expect(() => unwrapData({ items: [] })).toThrow(ApiError);
  });

  it('unwraps a list envelope and normalises the cursor', () => {
    expect(unwrapList<number>({ data: [1, 2], nextCursor: '9|z' })).toEqual({
      data: [1, 2],
      nextCursor: '9|z',
    });
    expect(unwrapList<number>({ data: [] })).toEqual({ data: [], nextCursor: null });
    expect(() => unwrapList({ data: 'nope' })).toThrow(ApiError);
    expect(() => unwrapList(null)).toThrow(ApiError);
  });
});
