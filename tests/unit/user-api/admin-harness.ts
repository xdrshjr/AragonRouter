import * as settingsRoute from '@/app/api/admin/settings/route';
import * as userRoute from '@/app/api/admin/users/[id]/route';
import * as userPasswordRoute from '@/app/api/admin/users/[id]/password/route';
import * as userSessionRoute from '@/app/api/admin/users/[id]/sessions/[sessionId]/route';
import * as usersRoute from '@/app/api/admin/users/route';
import { newId } from '@/lib/crypto';
import { execute } from '@/lib/db';
import { hashPassword, normalizeUsernameLower } from '@/lib/password';
import { SESSION_COOKIE, createSession } from '@/lib/sessions';
import type { UserPublic, UserRole, UserStatus } from '@/lib/types';
import { createUser, ensureBootstrapAdmin } from '@/lib/users';
import { TEST_MEMBER_PASSWORD } from '../test-helpers';

/**
 * Route harness for the admin users/settings work package (C-USERS-WIRE,
 * C-SETTINGS-WIRE).
 *
 * The tests drive the *real* exported handlers through Next 15's calling
 * convention (dynamic segments arrive as `params: Promise<...>`), with a real
 * session cookie minted by `createSession`. No `fetch` stub, no mocked guard: a
 * 401 here is the production 401.
 *
 * This file is a sibling of `harness.ts` (owned by the auth work package) and does
 * not touch it or `tests/unit/test-helpers.ts`.
 */

/** Absolute origin for the synthetic requests; route handlers only read the path. */
export const BASE_URL = 'http://localhost';

/** The `{data, nextCursor}` list envelope as C-USERS-WIRE defines it. */
export interface UserListEnvelope {
  data: UserPublic[];
  nextCursor: string | null;
}

export type AdminMethod = 'GET' | 'POST' | 'PATCH' | 'DELETE';

interface RouteContext {
  params: Promise<Record<string, string>>;
}

type RouteHandler = (request: Request, context?: RouteContext) => Promise<Response> | Response;

type RouteModule = Record<string, RouteHandler | undefined>;

interface ResolvedRoute {
  module: RouteModule;
  params: Record<string, string>;
}

/**
 * Map an `/api/admin/**` path to the route module Next would mount.
 *
 * Written as an explicit table instead of a directory scan so a renamed or missing
 * handler fails loudly here (`unmapped admin route`) rather than silently testing
 * nothing.
 */
export function resolveAdminRoute(pathname: string): ResolvedRoute {
  if (pathname === '/api/admin/users') {
    return { module: usersRoute as unknown as RouteModule, params: {} };
  }
  if (pathname === '/api/admin/settings') {
    return { module: settingsRoute as unknown as RouteModule, params: {} };
  }

  const passwordReset = /^\/api\/admin\/users\/([^/]+)\/password$/.exec(pathname);
  if (passwordReset?.[1]) {
    return {
      module: userPasswordRoute as unknown as RouteModule,
      params: { id: decodeURIComponent(passwordReset[1]) },
    };
  }

  const sessionRevoke = /^\/api\/admin\/users\/([^/]+)\/sessions\/([^/]+)$/.exec(pathname);
  if (sessionRevoke?.[1] && sessionRevoke[2]) {
    return {
      module: userSessionRoute as unknown as RouteModule,
      params: {
        id: decodeURIComponent(sessionRevoke[1]),
        sessionId: decodeURIComponent(sessionRevoke[2]),
      },
    };
  }

  const singleUser = /^\/api\/admin\/users\/([^/]+)$/.exec(pathname);
  if (singleUser?.[1]) {
    return {
      module: userRoute as unknown as RouteModule,
      params: { id: decodeURIComponent(singleUser[1]) },
    };
  }

  throw new Error(`admin-harness: unmapped admin users/settings route ${pathname}`);
}

export interface AdminCallInit {
  method?: AdminMethod;
  body?: unknown;
  headers?: Record<string, string>;
}

/** Build the `Request` an HTTP client would send (JSON body when one is given). */
export function adminRequest(pathname: string, init: AdminCallInit = {}): Request {
  const headers: Record<string, string> = { ...(init.headers ?? {}) };
  let body: string | undefined;
  if (init.body !== undefined) {
    headers['content-type'] = headers['content-type'] ?? 'application/json';
    body = typeof init.body === 'string' ? init.body : JSON.stringify(init.body);
  }
  return new Request(`${BASE_URL}${pathname}`, { method: init.method ?? 'GET', headers, body });
}

/**
 * Invoke the route handler for `pathname`.
 *
 * `body: 'not json'` (a string) is sent verbatim so the malformed-JSON cases test
 * the parser instead of the test helper.
 */
export async function callAdmin(
  pathname: string,
  init: AdminCallInit = {},
): Promise<Response> {
  const request = adminRequest(pathname, init);
  const method = init.method ?? 'GET';
  const route = resolveAdminRoute(new URL(request.url).pathname);
  const handler = route.module[method];
  if (!handler) {
    throw new Error(`admin-harness: ${pathname} does not implement ${method}`);
  }
  return handler(request, { params: Promise.resolve(route.params) });
}

export interface SignedIn {
  userId: string;
  sessionId: string;
  token: string;
  headers: Record<string, string>;
}

/** Mint a real session row and the matching `aragon_session` cookie header. */
export function signInAs(userId: string, userAgent = 'vitest-admin-users'): SignedIn {
  const session = createSession(userId, { userAgent });
  return {
    userId,
    sessionId: session.sessionId,
    token: session.token,
    headers: { cookie: `${SESSION_COOKIE}=${session.token}` },
  };
}

/** Sign in the bootstrap `admin` account (created on demand from ADMIN_PASSWORD). */
export function signInAdmin(): SignedIn {
  const admin = ensureBootstrapAdmin();
  return signInAs(admin.id, 'vitest-admin');
}

let usernameSequence = 0;

/** A username that is valid, unique per process run and short enough for the store. */
export function uniqueUsername(prefix: string): string {
  usernameSequence += 1;
  return `${prefix}-${process.pid.toString(36)}-${usernameSequence}`.slice(0, 32);
}

/** Create a member account through the real store. */
export function createMemberAccount(username = uniqueUsername('member')): UserPublic {
  return createUser({
    username,
    password: TEST_MEMBER_PASSWORD,
    role: 'member',
    displayName: 'Member Account',
  });
}

/** Create a second administrator (needed to exercise the last-admin rules). */
export function createAdminAccount(username = uniqueUsername('admin')): UserPublic {
  return createUser({
    username,
    password: TEST_MEMBER_PASSWORD,
    role: 'admin',
    displayName: 'Second Admin',
  });
}

interface SeedUsersOptions {
  prefix?: string;
  role?: UserRole;
  status?: UserStatus;
  /** `created_at` of the first row; later rows are one millisecond apart. */
  firstCreatedAt?: number;
}

/**
 * Bulk fixture for the page-size test.
 *
 * Hashing a hundred passwords would cost more than the rest of this file, so the
 * rows are inserted directly with one reused hash. They are never authenticated
 * with; only `GET /api/admin/users` reads them. Distinct `created_at` values keep
 * the keyset ordering deterministic regardless of how fast the rows were written.
 */
export function seedUsers(count: number, options: SeedUsersOptions = {}): void {
  const prefix = options.prefix ?? 'seed';
  const role = options.role ?? 'member';
  const status = options.status ?? 'active';
  const firstCreatedAt = options.firstCreatedAt ?? 1_700_000_000_000;
  const sharedHash = hashPassword('Bulk-Fixture-Passw0rd');
  for (let index = 0; index < count; index += 1) {
    const username = `${prefix}${String(index).padStart(3, '0')}`;
    const createdAt = firstCreatedAt + index;
    execute(
      `INSERT INTO users
        (id, username, username_lower, display_name, password_hash,
           role, status, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)`,
      [
        newId(),
        username,
        normalizeUsernameLower(username),
        sharedHash,
        role,
        status,
        createdAt,
        createdAt,
      ],
    );
  }
}

/** Keys of the C-USERS-WIRE `UserPublic` DTO, sorted. */
export const USER_PUBLIC_KEYS = [
  'createdAt',
  'displayName',
  'id',
  'lastLoginAt',
  'role',
  'status',
  'updatedAt',
  'username',
].sort();

/** Keys of the C-USERS-WIRE `UserSessionPublic` DTO, sorted. */
export const USER_SESSION_KEYS = [
  'createdAt',
  'current',
  'expiresAt',
  'id',
  'ip',
  'lastSeenAt',
  'userAgent',
].sort();

/** Every key of the C-SETTINGS-WIRE payload, sorted. */
export const SETTINGS_KEYS = ['registration'].sort();
