/**
 * Cross-package test harness for the console UI work package.
 *
 * The console never talks to SQLite and never imports `src/lib`: it speaks the
 * published `/api/admin/**` contract (C3-C8) over `fetch`. To test that boundary
 * honestly, this harness installs a `fetch` stub that resolves every `/api/admin/**`
 * URL to the *real* gateway route handler (owned by `gw-hardening`), keeps the
 * `aragon_session` cookie in a jar exactly like a browser would, and fails loudly on
 * any other URL unless a test registered an upstream stub.
 *
 * The result is a genuine end-to-end contract test between the two work packages:
 * the console's typed client (`src/components/console/api.ts`) on one side and the
 * gateway's own handlers on the other, with no HTTP server and no real network.
 */

import { vi } from 'vitest';

import * as keysIdRoute from '@/app/api/admin/keys/[id]/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as providerTestRoute from '@/app/api/admin/providers/[id]/test/route';
import * as providersIdRoute from '@/app/api/admin/providers/[id]/route';
import * as providersRoute from '@/app/api/admin/providers/route';
import * as sessionRoute from '@/app/api/admin/session/route';
import * as statsRoute from '@/app/api/admin/stats/route';
import { resetDbForTests } from '@/lib/db';
import { resetLoginThrottle } from '@/lib/login-throttle';

/** Origin used for the synthetic requests; the console always sends relative URLs. */
export const BASE_URL = 'http://console.test';

/** Values the gateway expects in the environment (C1). */
export const TEST_ENCRYPTION_KEY = '0123456789abcdef'.repeat(4);
export const TEST_SESSION_SECRET = 'ui-boundary-session-secret-0123456789abcdef';
export const TEST_ADMIN_PASSWORD = 'ui-boundary-admin-password';

/** The cookie name the console documents (C3) - asserted against the real Set-Cookie. */
export const SESSION_COOKIE_NAME = 'aragon_session';

type RouteHandler = (
  request: Request,
  context?: { params: Promise<Record<string, string>> },
) => Promise<Response> | Response;

type RouteModule = Record<string, RouteHandler | undefined>;

interface ResolvedRoute {
  module: RouteModule;
  params?: Record<string, string>;
}

/** Install C1 environment values and start from an empty in-memory database. */
export function prepareGatewayEnv(): void {
  process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
  process.env.SESSION_SECRET = TEST_SESSION_SECRET;
  process.env.ADMIN_PASSWORD = TEST_ADMIN_PASSWORD;
  process.env.DATABASE_PATH = ':memory:';
  delete process.env.COOKIE_SECURE;
  resetDbForTests();
  resetLoginThrottle();
}

function resolveRoute(pathname: string): ResolvedRoute {
  const path = pathname.replace(/^\/api\/admin/, '');
  if (path === '/session') return { module: sessionRoute as unknown as RouteModule };
  if (path === '/keys') return { module: keysRoute as unknown as RouteModule };
  if (path === '/stats') return { module: statsRoute as unknown as RouteModule };
  if (path === '/logs') return { module: logsRoute as unknown as RouteModule };
  if (path === '/providers') return { module: providersRoute as unknown as RouteModule };

  const keysId = /^\/keys\/([^/]+)$/.exec(path);
  if (keysId?.[1]) {
    return {
      module: keysIdRoute as unknown as RouteModule,
      params: { id: decodeURIComponent(keysId[1]) },
    };
  }

  const providerTest = /^\/providers\/([^/]+)\/test$/.exec(path);
  if (providerTest?.[1]) {
    return {
      module: providerTestRoute as unknown as RouteModule,
      params: { id: decodeURIComponent(providerTest[1]) },
    };
  }

  const providerId = /^\/providers\/([^/]+)$/.exec(path);
  if (providerId?.[1]) {
    return {
      module: providersIdRoute as unknown as RouteModule,
      params: { id: decodeURIComponent(providerId[1]) },
    };
  }

  throw new Error(`admin-harness: unmapped admin route ${pathname}`);
}

/** Stub for every non-admin URL (the upstream probe, for instance). */
export type UpstreamHandler = (request: Request) => Promise<Response>;

export interface AdminHarness {
  /** The `fetch` stub to install with `vi.stubGlobal`. */
  fetch: typeof fetch;
  /** Every admin call the console made, in order. */
  calls: { method: string; path: string }[];
  /** Raw cookie value the browser jar holds after the latest response. */
  cookie(): string | null;
  /**
   * Overwrite the cookie jar directly.
   *
   * A browser can end up holding a value this console never minted: the cookie is
   * forgeable in devtools, it can be replayed from a backup, it can expire while the
   * tab stays open, or the secret can be rotated under it. Tests for those cases
   * need to present an arbitrary `aragon_session` value, which `setCookie` allows -
   * the response handler above only ever stores what the server actually sent.
   */
  setCookie(token: string | null): void;
  /** Replace the external (upstream) network; `null` restores "no real network". */
  setUpstream(handler: UpstreamHandler | null): void;
  /** Clear recorded calls and the cookie jar. */
  reset(): void;
}

/** Create a `fetch` implementation that drives the real gateway handlers. */
export function createAdminHarness(): AdminHarness {
  let token: string | null = null;
  let upstream: UpstreamHandler | null = null;
  const calls: { method: string; path: string }[] = [];

  const harnessFetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const rawUrl =
      typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const url = new URL(rawUrl, BASE_URL);
    const method = (init?.method ?? 'GET').toUpperCase();
    const headers = new Headers(
      typeof init?.headers === 'undefined'
        ? undefined
        : (init.headers as ConstructorParameters<typeof Headers>[0]),
    );

    if (!url.pathname.startsWith('/api/admin')) {
      if (!upstream) {
        throw new Error(`admin-harness: unexpected external request to ${url.toString()}`);
      }
      return upstream(
        new Request(url, {
          method,
          headers,
          body: typeof init?.body === 'string' ? init.body : undefined,
        }),
      );
    }

    calls.push({ method, path: `${url.pathname}${url.search}` });
    if (token !== null) headers.set('cookie', `${SESSION_COOKIE_NAME}=${token}`);
    else headers.delete('cookie');

    const request = new Request(url, {
      method,
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    });

    const route = resolveRoute(url.pathname);
    const handler = route.module[method];
    if (!handler) {
      throw new Error(`admin-harness: ${url.pathname} does not implement ${method}`);
    }
    const response = await handler(
      request,
      route.params ? { params: Promise.resolve(route.params) } : undefined,
    );

    // Browser-like cookie handling: keep a session, drop it on the clearing cookie.
    const setCookie = response.headers.get('set-cookie');
    if (setCookie !== null) {
      const match = /(?:^|;\s*)aragon_session=([^;]*)/.exec(setCookie);
      const value = match?.[1] ?? '';
      const clears =
        value.length === 0 || /max-age=0/i.test(setCookie) || /expires=thu, 01 jan 1970/i.test(setCookie);
      token = clears ? null : value;
    }

    return response;
  }) as typeof fetch;

  return {
    fetch: harnessFetch,
    calls,
    cookie: () => token,
    setCookie(value) {
      token = value;
    },
    setUpstream(handler) {
      upstream = handler;
    },
    reset() {
      token = null;
      upstream = null;
      calls.length = 0;
    },
  };
}

/** Install the harness on `globalThis.fetch` and hand back its controls. */
export function installAdminHarness(): AdminHarness {
  const harness = createAdminHarness();
  vi.stubGlobal('fetch', harness.fetch);
  return harness;
}
