/**
 * Second boundary suite: session forgery/expiry, brute-force lockout, keyset
 * pagination with duplicate timestamps, hostile filters and exact payload shapes.
 *
 * Like `boundary.test.ts` this runs the console's own transport (`api.ts`) against
 * the *real* `/api/admin/**` route handlers (gw-hardening) through
 * `support/admin-harness.ts` - no HTTP server, no real network, no jsdom.
 *
 * The cases here are the ones a per-package unit test cannot catch: they only fail
 * when the console and the gateway disagree about a token, a cursor, a filter or an
 * envelope, so they are the integration risk of this work package.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installAdminHarness,
  prepareGatewayEnv,
  TEST_ADMIN_PASSWORD,
  TEST_SESSION_SECRET,
  type AdminHarness,
} from './support/admin-harness';

import {
  ADMIN_API_BASE,
  ApiError,
  SESSION_EXPIRED_MESSAGE,
  createKey,
  createProvider,
  getStats,
  isUnauthorized,
  listKeys,
  listLogs,
  listProviders,
  revokeKey,
  signIn,
  signOut,
  testProvider,
  updateProvider,
} from '@/components/console/api';
import { buildLogsQuery, mergeLogPages } from '@/components/console/log-query';
import { buildSeriesGeometry } from '@/components/console/chart';
import { hasSessionCookieShape } from '@/components/console/session-gate';
import {
  resetSessionExpiredListeners,
  subscribeSessionExpired,
  watchSessionExpiry,
} from '@/components/console/session-expiry';
import { SESSION_TTL_MS, createSessionToken } from '@/lib/auth';
import { insertRequestLog } from '@/lib/logs';
import type { CreateProviderPayload } from '@/components/console/types';

const UPSTREAM_SECRET = 'sk-ant-hardening-boundary-secret';

let harness: AdminHarness;

beforeEach(() => {
  prepareGatewayEnv();
  harness = installAdminHarness();
});

afterEach(() => {
  harness.reset();
  resetSessionExpiredListeners();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an ApiError');
}

function providerPayload(overrides: Partial<CreateProviderPayload> = {}): CreateProviderPayload {
  return {
    name: 'Anthropic hardening',
    protocol: 'anthropic',
    baseUrl: 'https://upstream.invalid',
    apiKey: UPSTREAM_SECRET,
    enabled: true,
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* C3 - the console cookie is not a credential, the API is the authority      */
/* -------------------------------------------------------------------------- */

describe('C3 gate vs API: only the API can prove a session', () => {
  it('a forged cookie passes the advisory shape check but the API rejects it', async () => {
    await signIn(TEST_ADMIN_PASSWORD);

    // Correctly *shaped* for C-TOKEN (`<32 hex>.<64 hex>`) but backed by no row: the
    // server-side gate in session-gate.ts accepts this (it cannot verify without the
    // session store), so the 401 from the API - and the redirect it triggers - is the
    // only thing standing between an attacker and the console.
    const forged = `${'ab'.repeat(16)}.${'a'.repeat(64)}`;
    harness.setCookie(forged);
    expect(hasSessionCookieShape(forged)).toBe(true);

    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const error = await captureApiError(listKeys());
    expect(error.status).toBe(401);
    expect(isUnauthorized(error)).toBe(true);
    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a genuinely minted but expired session is rejected with the same signal', async () => {
    // A real database session minted in the past: shape check passes, the secret
    // matches its stored hash, and only the expiry comparison saves the console.
    const stale = createSessionToken(Date.now() - SESSION_TTL_MS - 5_000, TEST_SESSION_SECRET);
    harness.setCookie(stale);
    expect(hasSessionCookieShape(stale)).toBe(true);

    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const error = await captureApiError(listProviders());
    expect(error.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('a token whose secret half was tampered with is rejected even though it is live', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const valid = harness.cookie() ?? '';
    expect(hasSessionCookieShape(valid)).toBe(true);

    // Flip one nibble of the secret half: same shape, same session id, wrong secret -
    // the store only ever holds sha256(secret), so this can never authenticate.
    const [sessionId, secret] = valid.split('.');
    const tamperedSecret = `${secret?.[0] === 'a' ? 'b' : 'a'}${(secret ?? '').slice(1)}`;
    const tampered = `${sessionId}.${tamperedSecret}`;
    expect(tampered).not.toBe(valid);

    harness.setCookie(tampered);
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    const error = await captureApiError(listKeys());
    expect(error.status).toBe(401);
    expect(expired).toHaveBeenCalledTimes(1);
  });

  it('an empty or truncated cookie is refused without any session at all', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const valid = harness.cookie();
    expect(valid).not.toBeNull();

    for (const broken of ['', '.', '123.', '.deadbeef', '123.zz']) {
      harness.setCookie(broken);
      const error = await captureApiError(listKeys());
      expect(error.status).toBe(401);
    }
  });

  it('parallel requests with an expired session navigate exactly once', async () => {
    const redirect = vi.fn();
    const watcher = watchSessionExpiry(redirect);

    const results = await Promise.all([
      captureApiError(listKeys()),
      captureApiError(listProviders()),
      captureApiError(getStats('24h')),
      captureApiError(listLogs({ limit: 5 })),
    ]);

    for (const error of results) {
      expect(error.status).toBe(401);
      expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    }
    // Four 401s, one redirect: the shell must not fight over the history entry.
    expect(redirect).toHaveBeenCalledTimes(1);
    watcher.unsubscribe();
  });

  it('signing in again restores access after the session expired', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    await signOut();
    await expect(captureApiError(listKeys())).resolves.toBeInstanceOf(ApiError);

    await signIn(TEST_ADMIN_PASSWORD);
    await expect(listKeys()).resolves.toEqual([]);
    // A successful sign-in must not itself announce an expiry.
    const expired = vi.fn();
    subscribeSessionExpired(expired);
    await expect(listKeys()).resolves.toEqual([]);
    expect(expired).not.toHaveBeenCalled();
  });
});

/* -------------------------------------------------------------------------- */
/* C3 - brute force                                                          */
/* -------------------------------------------------------------------------- */

describe('C3 login throttle through the real route', () => {
  /** The gateway allows 30 failures per minute per fingerprint (`login-throttle.ts`). */
  const MAX_FAILURES = 30;

  it(`answers 429 after ${MAX_FAILURES} bad passwords and the console shows the message`, async () => {
    const expired = vi.fn();
    subscribeSessionExpired(expired);

    for (let attempt = 0; attempt < MAX_FAILURES; attempt += 1) {
      const error = await captureApiError(signIn(`bad-${attempt}`));
      expect(error.status).toBe(401);
      // The password is never echoed back, not even in a rejected attempt.
      expect(error.message).not.toContain(`bad-${attempt}`);
    }

    const throttled = await captureApiError(signIn('bad-final'));
    expect(throttled.status).toBe(429);
    expect(throttled.message.toLowerCase()).toContain('too many');
    expect(throttled.message).not.toBe(SESSION_EXPIRED_MESSAGE);
    // A 429 is not an expired session: redirecting to /login would be a loop.
    expect(expired).not.toHaveBeenCalled();
    expect(harness.cookie()).toBeNull();

    // The lockout is per fingerprint, so even the correct password is refused while
    // it lasts - the operator must wait, which is the documented behaviour.
    const correct = await captureApiError(signIn(TEST_ADMIN_PASSWORD));
    expect(correct.status).toBe(429);
    expect(harness.cookie()).toBeNull();
  });

  it('never sets a cookie for a failed attempt', async () => {
    for (const password of ['', ' ', 'x', UPSTREAM_SECRET]) {
      await captureApiError(signIn(password));
      expect(harness.cookie()).toBeNull();
    }
    expect(harness.calls.filter((call) => call.path === `${ADMIN_API_BASE}/session`)).toHaveLength(4);
  });
});

/* -------------------------------------------------------------------------- */
/* C8 - keyset pagination                                                     */
/* -------------------------------------------------------------------------- */

describe('C8 pagination is stable across duplicate timestamps', () => {
  it('walks three rows that share one created_at without losing or repeating any', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const createdAt = Date.now() - 1_000;
    const ids = ['tie-ccc', 'tie-aaa', 'tie-bbb'].map((id) =>
      insertRequestLog({
        id,
        protocol: 'anthropic',
        path: '/api/v1/messages',
        model: 'claude-sonnet-4-5',
        upstream: 'https://api.anthropic.com',
        status: 200,
        latencyMs: 100,
        inputTokens: 1,
        outputTokens: 2,
        createdAt,
      }),
    );
    expect(new Set(ids).size).toBe(3);

    const first = await listLogs({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // The cursor is `<created_at>|<id>` and must carry the tie-breaker id.
    expect(first.nextCursor?.startsWith(`${createdAt}|`)).toBe(true);

    const second = await listLogs({ limit: 2, cursor: first.nextCursor });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const merged = mergeLogPages(first.data, second.data);
    expect(merged.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(new Set(merged.map((row) => row.id)).size).toBe(3);

    // Re-reading the same page must be idempotent: no row appears twice.
    const repeated = await listLogs({ limit: 2 });
    expect(mergeLogPages(first.data, repeated.data)).toHaveLength(2);
  });

  it('a page fetched twice with the same cursor returns the same rows', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    for (let index = 0; index < 4; index += 1) {
      insertRequestLog({
        protocol: 'openai',
        path: '/api/v1/chat/completions',
        model: 'gpt-4o-mini',
        status: 200,
        latencyMs: 10 + index,
        createdAt: Date.now() - index * 1_000,
      });
    }

    const first = await listLogs({ limit: 2 });
    const cursor = first.nextCursor;
    expect(cursor).not.toBeNull();
    const left = await listLogs({ limit: 2, cursor });
    const right = await listLogs({ limit: 2, cursor });

    expect(left.data.map((row) => row.id)).toEqual(right.data.map((row) => row.id));
    expect(left.nextCursor).toBe(right.nextCursor);
  });
});

/* -------------------------------------------------------------------------- */
/* C8 - hostile filters                                                       */
/* -------------------------------------------------------------------------- */

describe('C8 filters survive hostile input', () => {
  function seed(): void {
    insertRequestLog({
      protocol: 'anthropic',
      path: '/api/v1/messages',
      model: 'claude-sonnet-4-5',
      status: 200,
      latencyMs: 50,
      createdAt: Date.now() - 2_000,
    });
    insertRequestLog({
      protocol: 'openai',
      path: '/api/v1/chat/completions',
      model: 'gpt-4o-mini',
      status: 500,
      latencyMs: 60,
      error: 'boom',
      createdAt: Date.now() - 1_000,
    });
  }

  it('treats an injection-shaped model filter as a literal, not as SQL', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    seed();

    const injected = await listLogs({ limit: 50, model: "gpt-4o-mini' OR 1=1 --" });
    expect(injected.data).toEqual([]);

    const wildcard = await listLogs({ limit: 50, model: '%' });
    expect(wildcard.data).toEqual([]);

    // The plain model id still matches exactly.
    const exact = await listLogs({ limit: 50, model: 'gpt-4o-mini' });
    expect(exact.data).toHaveLength(1);
  });

  it('drops an unusable status filter instead of showing a wrong result set', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    seed();

    // `buildLogsQuery` normalises the value away, so the request carries no status
    // filter and the table shows every row rather than silently none.
    const query = buildLogsQuery({ limit: 50, status: '500 OR 1=1' });
    expect(query).not.toContain('status=');

    const rows = await listLogs({ limit: 50, status: '500 OR 1=1' });
    expect(rows.data).toHaveLength(2);
  });

  it('keeps the pipe of the cursor intact through URL encoding', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    seed();

    const cursor = '1700000000000|id-with-|-and-&-chars';
    const query = buildLogsQuery({ limit: 2, cursor });
    expect(query).toContain('cursor=');
    expect(query).not.toContain('|');
    expect(query).not.toContain('&id');

    // The server sees the decoded value: a well-formed (if empty) page, not a 400.
    const page = await listLogs({ limit: 2, cursor });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });

  it('rejects a cursor without the <created_at>|<id> separator', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    seed();

    for (const cursor of ['1700000000000', '|id-only', '|', 'abc|id']) {
      const error = await captureApiError(listLogs({ limit: 2, cursor }));
      expect(error.status).toBe(400);
      expect(error.message).toContain('cursor');
    }
  });
});

/* -------------------------------------------------------------------------- */
/* C7/C8 - exact payload shapes                                               */
/* -------------------------------------------------------------------------- */

describe('C7/C8 payload shapes match the console types field for field', () => {
  it('a log row carries exactly the C8 fields', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const key = await createKey('log owner');
    insertRequestLog({
      protocol: 'openai',
      path: '/api/v1/chat/completions',
      model: 'gpt-4o-mini',
      upstream: 'https://api.openai.com',
      status: 200,
      latencyMs: 42,
      inputTokens: 3,
      outputTokens: 4,
      apiKeyId: key.id,
      stream: true,
    });

    const page = await listLogs({ limit: 10 });
    const row = page.data[0];
    expect(row).toBeDefined();
    if (!row) return;

    expect(Object.keys(row).sort()).toEqual([
      'apiKeyId',
      'createdAt',
      'error',
      'id',
      'inputTokens',
      'latencyMs',
      'model',
      'outputTokens',
      'path',
      'protocol',
      'status',
      'stream',
      'upstream',
    ]);
    // The key id - never the key itself - is what the log references.
    expect(row.apiKeyId).toBe(key.id);
    expect(JSON.stringify(row)).not.toContain(key.key);
    expect(row.stream).toBe(true);
    expect(Number.isInteger(row.latencyMs)).toBe(true);
    expect(Number.isInteger(row.inputTokens)).toBe(true);
  });

  it('statistics are exact integers for every range and drive the chart', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const now = Date.now();
    const seed: readonly { inputTokens: number; outputTokens: number; status: number }[] = [
      { inputTokens: 7, outputTokens: 11, status: 200 },
      { inputTokens: 13, outputTokens: 17, status: 500 },
      { inputTokens: 19, outputTokens: 23, status: 200 },
      { inputTokens: 29, outputTokens: 31, status: 400 },
    ];
    for (const [index, row] of seed.entries()) {
      insertRequestLog({
        protocol: 'anthropic',
        path: '/api/v1/messages',
        model: 'claude-sonnet-4-5',
        status: row.status,
        latencyMs: 100 + index,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        createdAt: now - (index + 1) * 1_000,
      });
    }
    const expectedInput = seed.reduce((sum, row) => sum + row.inputTokens, 0);
    const expectedOutput = seed.reduce((sum, row) => sum + row.outputTokens, 0);

    const buckets: Record<string, number> = { '24h': 24, '7d': 7, '30d': 30 };
    for (const range of ['24h', '7d', '30d'] as const) {
      const stats = await getStats(range);
      expect(stats.range).toBe(range);
      expect(Object.keys(stats).sort()).toEqual(['byKey', 'byModel', 'range', 'series', 'totals']);
      expect(Object.keys(stats.totals).sort()).toEqual([
        'avgLatencyMs',
        'errorRate',
        'inputTokens',
        'outputTokens',
        'requests',
      ]);
      const point = stats.series[0];
      expect(point).toBeDefined();
      expect(Object.keys(point ?? {}).sort()).toEqual([
        'errors',
        'inputTokens',
        'outputTokens',
        'requests',
        't',
      ]);

      // Exact arithmetic: token totals are integers, never floats or strings.
      expect(stats.series).toHaveLength(buckets[range] ?? -1);
      expect(stats.totals.requests).toBe(seed.length);
      expect(stats.totals.inputTokens).toBe(expectedInput);
      expect(stats.totals.outputTokens).toBe(expectedOutput);
      expect(Number.isInteger(stats.totals.inputTokens)).toBe(true);
      expect(Number.isInteger(stats.totals.outputTokens)).toBe(true);
      expect(stats.series.reduce((sum, item) => sum + item.requests, 0)).toBe(seed.length);
      expect(stats.series.reduce((sum, item) => sum + item.inputTokens, 0)).toBe(expectedInput);
      // Two of four responses failed, so the rate is exactly 0.5.
      expect(stats.totals.errorRate).toBe(0.5);
      expect(stats.totals.avgLatencyMs).toBe(Math.round((100 + 101 + 102 + 103) / 4));

      const geometry = buildSeriesGeometry(stats.series, 'inputTokens');
      expect(geometry.points).toHaveLength(stats.series.length);
      expect(geometry.total).toBe(expectedInput);
      for (const item of geometry.points) {
        expect(Number.isFinite(item.x)).toBe(true);
        expect(Number.isFinite(item.y)).toBe(true);
      }
      expect(geometry.linePath).not.toMatch(/NaN|Infinity/);
    }
  });

  it('byModel and byKey group exactly what C7 documents', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const key = await createKey('usage owner');
    for (let index = 0; index < 3; index += 1) {
      insertRequestLog({
        protocol: 'anthropic',
        path: '/api/v1/messages',
        model: 'claude-sonnet-4-5',
        status: 200,
        latencyMs: 10,
        inputTokens: 2,
        outputTokens: 3,
        apiKeyId: key.id,
      });
    }
    insertRequestLog({
      protocol: 'openai',
      path: '/api/v1/chat/completions',
      model: 'gpt-4o-mini',
      status: 200,
      latencyMs: 10,
      apiKeyId: null,
    });

    const stats = await getStats('24h');
    const model = stats.byModel.find((row) => row.model === 'claude-sonnet-4-5');
    expect(model?.requests).toBe(3);
    expect(model?.inputTokens).toBe(6);
    expect(model?.outputTokens).toBe(9);
    expect(Object.keys(model ?? {}).sort()).toEqual([
      'inputTokens',
      'model',
      'outputTokens',
      'requests',
    ]);

    const byKey = stats.byKey.find((row) => row.apiKeyId === key.id);
    expect(byKey?.requests).toBe(3);
    expect(byKey?.name).toBe('usage owner');
    expect(Object.keys(byKey ?? {}).sort()).toEqual(['apiKeyId', 'name', 'requests']);
    expect(stats.byKey.reduce((sum, row) => sum + row.requests, 0)).toBe(stats.totals.requests);
  });
});

/* -------------------------------------------------------------------------- */
/* C3 - cookie transport details the console depends on                       */
/* -------------------------------------------------------------------------- */

describe('C3 cookie transport', () => {
  async function postSession(headers: Record<string, string>): Promise<Response> {
    return harness.fetch(`${ADMIN_API_BASE}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ password: TEST_ADMIN_PASSWORD }),
    });
  }

  it('marks the cookie Secure only behind HTTPS, so the dev console still works', async () => {
    const secure = await postSession({ 'x-forwarded-proto': 'https' });
    expect(secure.status).toBe(200);
    expect(secure.headers.get('set-cookie') ?? '').toContain('Secure');

    // A fresh attempt over plain HTTP must not set Secure, or the browser would drop
    // the cookie and every console call would answer 401.
    harness.reset();
    const plain = await postSession({ 'x-forwarded-proto': 'http' });
    expect(plain.status).toBe(200);
    const setCookie = plain.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('Max-Age=');
    expect(setCookie).not.toContain('Secure');
  });

  it('the session probe never mints a cookie and the delete clears it', async () => {
    const probe = await harness.fetch(`${ADMIN_API_BASE}/session`, { method: 'GET' });
    expect(probe.status).toBe(401);
    expect(probe.headers.get('set-cookie')).toBeNull();

    await postSession({});
    const check = await harness.fetch(`${ADMIN_API_BASE}/session`, { method: 'GET' });
    expect(check.status).toBe(200);
    expect(JSON.parse(await check.text())).toEqual({ data: { ok: true } });

    const cleared = await harness.fetch(`${ADMIN_API_BASE}/session`, { method: 'DELETE' });
    expect(cleared.status).toBe(200);
    expect(cleared.headers.get('set-cookie') ?? '').toContain('Max-Age=0');
    expect(harness.cookie()).toBeNull();
  });

  it('an error body never carries the password or a token', async () => {
    const wrong = await harness.fetch(`${ADMIN_API_BASE}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'not-the-password-123' }),
    });
    const text = await wrong.text();
    expect(wrong.status).toBe(401);
    expect(text).not.toContain('not-the-password-123');
    expect(text).not.toMatch(/aragon_session=/);
    expect(JSON.parse(text)).toEqual({ error: { message: 'invalid password' } });
  });
});

/* -------------------------------------------------------------------------- */
/* C6 - credential lifecycle                                                  */
/* -------------------------------------------------------------------------- */

describe('C6 provider credential lifecycle through the console', () => {
  it('rotates the credential on PATCH without ever returning it', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    // Deliberately different first/last four characters: `maskedKey` is
    // `<first4>…<last4>`, so only such a secret proves the mask really moved.
    const rotatedSecret = 'zzzz-rotated-hardening-secret-9999';

    const rotated = await updateProvider(created.id, { apiKey: rotatedSecret });
    expect(rotated.maskedKey).not.toBe(created.maskedKey);
    expect(rotated.maskedKey).not.toContain(rotatedSecret);
    expect(JSON.stringify(rotated)).not.toContain(rotatedSecret);
    expect(JSON.stringify(rotated)).not.toContain(UPSTREAM_SECRET);

    const listed = await listProviders();
    expect(JSON.stringify(listed)).not.toContain(rotatedSecret);
    expect(JSON.stringify(listed)).not.toContain(UPSTREAM_SECRET);
    expect(listed[0]?.maskedKey).toBe(rotated.maskedKey);
  });

  it('treats a reachable but unparsable /v1/models response as ok', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    harness.setUpstream(async () => new Response('<html>not json</html>', { status: 200 }));

    const result = await testProvider(created.id);
    expect(result.ok).toBe(true);
    expect(result.message).toContain('200');
    expect(result.message).not.toContain(UPSTREAM_SECRET);
  });

  it('reports a transport failure as ok:false with a readable message', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    harness.setUpstream(async () => {
      throw new TypeError('fetch failed');
    });

    const result = await testProvider(created.id);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(UPSTREAM_SECRET);
  });

  it('redacts a hostile upstream body that echoes the credential', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    harness.setUpstream(
      async () =>
        new Response(`invalid key ${UPSTREAM_SECRET}`, {
          status: 401,
          statusText: 'Unauthorized',
        }),
    );

    const result = await testProvider(created.id);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    // The gateway scrubs the credential out of the upstream-derived message.
    expect(result.message).not.toContain(UPSTREAM_SECRET);
  });

  it('refuses a provider whose baseUrl would leak credentials', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const error = await captureApiError(
      createProvider(providerPayload({ baseUrl: 'https://user:pass@upstream.invalid' })),
    );
    expect(error.status).toBe(400);
    expect(error.message.length).toBeGreaterThan(0);
    expect(await listProviders()).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Sensitive-data sweep over every admin response the console consumes       */
/* -------------------------------------------------------------------------- */

describe('no console request ever receives a secret', () => {
  it('keeps the key plaintext and the upstream credential out of every payload', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const key = await createKey('sweep');
    const provider = await createProvider(providerPayload());
    insertRequestLog({
      protocol: 'anthropic',
      path: '/api/v1/messages',
      model: 'claude-sonnet-4-5',
      upstream: 'https://upstream.invalid',
      status: 200,
      latencyMs: 10,
      apiKeyId: key.id,
    });

    const payloads = [
      JSON.stringify(await listKeys()),
      JSON.stringify(await listProviders()),
      JSON.stringify(await listLogs({ limit: 50 })),
      JSON.stringify(await getStats('7d')),
      JSON.stringify(provider),
      JSON.stringify(key),
    ].join('\n');

    expect(payloads).not.toContain(UPSTREAM_SECRET);
    expect(payloads).not.toContain(TEST_ADMIN_PASSWORD);
    // The plaintext key exists in exactly one response: the creation one.
    expect(payloads.split(key.key).length).toBe(2);
    expect(key.key).toMatch(/^ar-[0-9a-f]{32}$/);
  });

  it('a revoked key stays listed, keeps its id and revokes idempotently', async () => {
    await signIn(TEST_ADMIN_PASSWORD);
    const created = await createKey('to revoke');
    expect(await revokeKey(created.id)).toBe(created.id);

    const rows = await listKeys();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.revokedAt).not.toBeNull();
    expect(rows[0]?.id).toBe(created.id);

    // C5/GW contract: revoking twice is idempotent and keeps the first timestamp, so
    // a double click (or a retried request) never rewrites the audit trail.
    const firstRevokedAt = rows[0]?.revokedAt ?? null;
    await expect(revokeKey(created.id)).resolves.toBe(created.id);
    const after = await listKeys();
    expect(after[0]?.revokedAt).toBe(firstRevokedAt);

    // Revoking an unknown id is a surfaced 404, not a silent success.
    const error = await captureApiError(revokeKey('no-such-key'));
    expect(error.status).toBe(404);
    expect(error.message.length).toBeGreaterThan(0);
  });
});
