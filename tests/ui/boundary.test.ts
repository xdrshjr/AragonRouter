/**
 * Cross-module boundary tests: console-ui (consumer) against gw-hardening (producer).
 *
 * Everything here goes through `src/components/console/api.ts` - the module every
 * console page uses - and lands in the real `/api/admin/**` route handlers via the
 * harness in `support/admin-harness.ts`. That combination is the failure mode this
 * file exists to catch: the client and the gateway agreeing on their *own* unit
 * tests while disagreeing with each other (envelope shape, cookie flags, cursor
 * format, plaintext leaks, error codes).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  installAdminHarness,
  prepareGatewayEnv,
  type AdminHarness,
} from './support/admin-harness';

import {
  ADMIN_API_BASE,
  ApiError,
  SESSION_COOKIE_NAME,
  SESSION_EXPIRED_MESSAGE,
  createKey,
  createProvider,
  deleteProvider,
  getSession,
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
import { insertRequestLog } from '@/lib/logs';
import type { CreateProviderPayload } from '@/components/console/types';

const ADMIN_PASSWORD = 'ui-boundary-admin-password';
const UPSTREAM_SECRET = 'sk-ant-upstream-boundary-secret';

let harness: AdminHarness;

beforeEach(() => {
  prepareGatewayEnv();
  harness = installAdminHarness();
});

afterEach(() => {
  harness.reset();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

/** Run a promise and return the ApiError it must reject with. */
async function captureApiError(promise: Promise<unknown>): Promise<ApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof ApiError) return error;
    throw error;
  }
  throw new Error('expected the call to reject with an ApiError');
}

function seedLogs(): { ids: string[] } {
  const now = Date.now();
  const ids = [
    insertRequestLog({
      protocol: 'anthropic',
      path: '/api/v1/messages',
      model: 'claude-sonnet-4-5',
      upstream: 'https://api.anthropic.com',
      status: 200,
      latencyMs: 120,
      inputTokens: 10,
      outputTokens: 20,
      createdAt: now - 3_000,
    }),
    insertRequestLog({
      protocol: 'openai',
      path: '/api/v1/chat/completions',
      model: 'gpt-4o-mini',
      upstream: 'https://api.openai.com',
      status: 200,
      latencyMs: 80,
      inputTokens: 5,
      outputTokens: 7,
      stream: true,
      createdAt: now - 2_000,
    }),
    insertRequestLog({
      protocol: 'anthropic',
      path: '/api/v1/messages',
      model: 'claude-sonnet-4-5',
      upstream: 'https://api.anthropic.com',
      status: 500,
      latencyMs: 900,
      error: 'upstream exploded',
      createdAt: now - 1_000,
    }),
  ];
  return { ids };
}

function providerPayload(overrides: Partial<CreateProviderPayload> = {}): CreateProviderPayload {
  return {
    name: 'Anthropic production',
    protocol: 'anthropic',
    baseUrl: 'https://upstream.invalid',
    apiKey: UPSTREAM_SECRET,
    enabled: true,
    ...overrides,
  };
}

describe('C3 session: the console signs in against the real route', () => {
  it('stores a session cookie with the documented flags and gate-compatible shape', async () => {
    const response = await harness.fetch(`${ADMIN_API_BASE}/session`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: ADMIN_PASSWORD, }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ data: { ok: true } });

    const setCookie = response.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Path=/');
    expect(setCookie).toContain('SameSite=Lax');

    // The console-side gate must accept the token the gateway actually minted.
    const token = harness.cookie();
    expect(token).not.toBeNull();
    expect(hasSessionCookieShape(token)).toBe(true);
  });

  it('accepts the password through the typed client and validates the session', async () => {
    await signIn(ADMIN_PASSWORD);
    await expect(getSession()).resolves.toBe(true);
  });

  it('surfaces a wrong password as a generic 401 that never echoes the input', async () => {
    const error = await captureApiError(signIn('definitely-not-the-password'));
    expect(error.status).toBe(401);
    expect(isUnauthorized(error)).toBe(true);
    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    expect(error.message).not.toContain('definitely-not-the-password');
    expect(harness.cookie()).toBeNull();
  });

  it('surfaces an unauthenticated admin call as the session-expired error', async () => {
    const error = await captureApiError(listKeys());
    expect(error.status).toBe(401);
    expect(isUnauthorized(error)).toBe(true);
    expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    // The server body is `{error:{message:"unauthorized"}}` (C3); the console
    // deliberately replaces it with an actionable message for the operator.
    expect(error.message.toLowerCase()).not.toContain('unauthorized');
  });

  it('clears the cookie on sign out so the next request is rejected', async () => {
    await signIn(ADMIN_PASSWORD);
    await signOut();
    expect(harness.cookie()).toBeNull();
    const error = await captureApiError(listKeys());
    expect(error.status).toBe(401);
  });
});

describe('C5 keys: plaintext appears exactly once', () => {
  it('creates a key, lists only the prefix and revokes it', async () => {
    await signIn(ADMIN_PASSWORD);
    await expect(listKeys()).resolves.toEqual([]);

    const created = await createKey('Production relay');
    expect(created.key).toMatch(/^ar-[0-9a-f]{32}$/);
    expect(created.name).toBe('Production relay');
    expect(created.key.startsWith(created.keyPrefix)).toBe(true);
    expect(created.revokedAt).toBeNull();
    expect(created.lastUsedAt).toBeNull();
    expect(Number.isNaN(Date.parse(created.createdAt))).toBe(false);

    const rows = await listKeys();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect(row).toBeDefined();
    if (!row) return;
    // C5: the list shape carries no `key` and no hash - only the prefix.
    expect(Object.keys(row).sort()).toEqual([
      'createdAt',
      'id',
      'keyPrefix',
      'lastUsedAt',
      'name',
      'revokedAt',
    ]);
    expect(JSON.stringify(row)).not.toContain(created.key);
    expect(row.keyPrefix).toBe(created.keyPrefix);

    await expect(revokeKey(created.id)).resolves.toBe(created.id);
    const after = await listKeys();
    expect(after[0]?.revokedAt).not.toBeNull();
  });

  it('rejects a revoke for an unknown id with a C4 error message', async () => {
    await signIn(ADMIN_PASSWORD);
    const error = await captureApiError(revokeKey('does-not-exist'));
    expect(error.status).toBeGreaterThanOrEqual(400);
    expect(error.status).toBeLessThan(500);
    expect(error.message.length).toBeGreaterThan(0);
  });
});

describe('C6 providers: CRUD, masked credential and connectivity probe', () => {
  it('never leaks the upstream credential through the public shape', async () => {
    await signIn(ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());

    expect(created.protocol).toBe('anthropic');
    expect(created.enabled).toBe(true);
    expect(created.maskedKey.length).toBeGreaterThan(0);
    expect(created.maskedKey).not.toContain(UPSTREAM_SECRET);
    expect(JSON.stringify(created)).not.toContain(UPSTREAM_SECRET);

    const rows = await listProviders();
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(UPSTREAM_SECRET);
    expect(Object.keys(rows[0] ?? {}).sort()).toEqual([
      'baseUrl',
      'createdAt',
      'enabled',
      'id',
      'maskedKey',
      'name',
      'protocol',
    ]);
  });

  it('patches enabled without touching the stored credential', async () => {
    await signIn(ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());

    const disabled = await updateProvider(created.id, { enabled: false });
    expect(disabled.enabled).toBe(false);
    expect(disabled.maskedKey).toBe(created.maskedKey);
    expect(disabled.name).toBe(created.name);

    const renamed = await updateProvider(created.id, { name: 'Anthropic secondary' });
    expect(renamed.name).toBe('Anthropic secondary');
    expect(renamed.maskedKey).toBe(created.maskedKey);
  });

  it('reports a reachable upstream through POST /providers/[id]/test', async () => {
    await signIn(ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    harness.setUpstream(async () =>
      new Response(JSON.stringify({ data: [{ id: 'claude-sonnet-4-5' }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const result = await testProvider(created.id);
    expect(result.ok).toBe(true);
    expect(typeof result.message).toBe('string');
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(UPSTREAM_SECRET);
  });

  it('reports a failing upstream as ok:false with a readable message', async () => {
    await signIn(ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    harness.setUpstream(async () => new Response('nope', { status: 503 }));

    const result = await testProvider(created.id);
    expect(result.ok).toBe(false);
    expect(result.message.length).toBeGreaterThan(0);
    expect(result.message).not.toContain(UPSTREAM_SECRET);
  });

  it('deletes a provider and returns the confirmed id', async () => {
    await signIn(ADMIN_PASSWORD);
    const created = await createProvider(providerPayload());
    await expect(deleteProvider(created.id)).resolves.toBe(created.id);
    await expect(listProviders()).resolves.toEqual([]);
  });
});

describe('C7 stats feeding the console chart', () => {
  it('agrees with the request log and produces drawable geometry', async () => {
    await signIn(ADMIN_PASSWORD);
    const { ids } = seedLogs();

    const stats = await getStats('7d');
    expect(stats.range).toBe('7d');
    expect(stats.totals.requests).toBe(ids.length);
    expect(stats.totals.inputTokens).toBe(15);
    expect(stats.totals.outputTokens).toBe(27);
    expect(stats.totals.errorRate).toBeGreaterThan(0);
    expect(stats.totals.errorRate).toBeLessThanOrEqual(1);
    expect(stats.totals.avgLatencyMs).toBeGreaterThan(0);
    expect(stats.series.length).toBeGreaterThan(0);

    const seriesTotal = stats.series.reduce((sum, point) => sum + point.requests, 0);
    expect(seriesTotal).toBe(stats.totals.requests);

    const models = stats.byModel.map((row) => row.model).sort();
    expect(models).toEqual(['claude-sonnet-4-5', 'gpt-4o-mini']);
    const sonnet = stats.byModel.find((row) => row.model === 'claude-sonnet-4-5');
    expect(sonnet?.requests).toBe(2);
    expect(stats.byKey.length).toBeGreaterThanOrEqual(1);

    // The overview chart consumes this payload directly.
    const geometry = buildSeriesGeometry(stats.series, 'requests');
    expect(geometry.points).toHaveLength(stats.series.length);
    expect(geometry.total).toBe(stats.totals.requests);
    expect(Number.isFinite(geometry.max)).toBe(true);
    for (const point of geometry.points) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeGreaterThanOrEqual(0);
    }
    expect(geometry.linePath).not.toMatch(/NaN/);
  });

  it('coerces an unsupported range to the documented default instead of crashing', async () => {
    await signIn(ADMIN_PASSWORD);
    seedLogs();
    // The console type only allows 24h|7d|30d, so this is the hostile path. The
    // gateway's published behaviour is a defensive fallback to `7d`, which the
    // chart must still be able to draw from.
    const stats = await getStats('90d' as unknown as '7d');
    expect(stats.range).toBe('7d');
    expect(stats.totals.requests).toBe(3);
    expect(() => buildSeriesGeometry(stats.series, 'requests')).not.toThrow();
  });
});

describe('C8 logs: filters and cursor pagination through the console client', () => {
  it('walks both pages and merges them without duplicates', async () => {
    await signIn(ADMIN_PASSWORD);
    const { ids } = seedLogs();

    const first = await listLogs({ limit: 2 });
    expect(first.data).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    // Newest first: the 500 row is the most recent insert.
    expect(first.data[0]?.status).toBe(500);
    expect(first.data[0]?.error).toBe('upstream exploded');
    expect(first.data[0]?.stream).toBe(false);
    expect(first.data[1]?.stream).toBe(true);

    const second = await listLogs({ limit: 2, cursor: first.nextCursor });
    expect(second.data).toHaveLength(1);
    expect(second.nextCursor).toBeNull();

    const merged = mergeLogPages(first.data, second.data);
    expect(merged.map((row) => row.id).sort()).toEqual([...ids].sort());
    expect(new Set(merged.map((row) => row.id)).size).toBe(ids.length);
  });

  it('applies the status filter the logs page sends', async () => {
    await signIn(ADMIN_PASSWORD);
    seedLogs();
    const filtered = await listLogs({ limit: 50, status: '500' });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.status).toBe(500);
    expect(filtered.nextCursor).toBeNull();
  });

  it('applies the model filter the logs page sends', async () => {
    await signIn(ADMIN_PASSWORD);
    seedLogs();
    const filtered = await listLogs({ limit: 50, model: 'gpt-4o-mini' });
    expect(filtered.data).toHaveLength(1);
    expect(filtered.data[0]?.model).toBe('gpt-4o-mini');
  });

  it('round-trips the exact query string the logs page renders', async () => {
    await signIn(ADMIN_PASSWORD);
    seedLogs();
    const query = buildLogsQuery({ limit: 50, status: '500', model: 'claude-sonnet-4-5' });
    expect(query).toContain('status=500');
    expect(query).toContain('model=claude-sonnet-4-5');

    const filtered = await listLogs({ limit: 50, status: '500', model: 'claude-sonnet-4-5' });
    expect(filtered.data).toHaveLength(1);
  });

  it('turns a malformed cursor into a surfaced 400 instead of an infinite scroll', async () => {
    await signIn(ADMIN_PASSWORD);
    seedLogs();
    const error = await captureApiError(listLogs({ limit: 2, cursor: 'not-a-cursor' }));
    expect(error.status).toBe(400);
    expect(error.message).toContain('cursor');
  });

  it('reports a mutation rejected with 401 as a session-expired error', async () => {
    // No session: the console must be able to recognise the failure and redirect,
    // whatever the caller does with it afterwards.
    await signIn(ADMIN_PASSWORD);
    const created = await createKey('expiring');
    await signOut();

    for (const call of [
      () => createKey('another'),
      () => revokeKey(created.id),
      () => listKeys(),
      () => createProvider(providerPayload()),
      () => updateProvider('any-id', { enabled: false }),
      () => deleteProvider('any-id'),
      () => testProvider('any-id'),
      () => getStats('24h'),
      () => listLogs({ limit: 1 }),
    ]) {
      const error = await captureApiError(call());
      expect(error.status).toBe(401);
      expect(isUnauthorized(error)).toBe(true);
      expect(error.message).toBe(SESSION_EXPIRED_MESSAGE);
    }
  });

  it('returns an empty page with no cursor when the log is empty', async () => {
    await signIn(ADMIN_PASSWORD);
    const page = await listLogs({ limit: 50 });
    expect(page.data).toEqual([]);
    expect(page.nextCursor).toBeNull();
  });
});
