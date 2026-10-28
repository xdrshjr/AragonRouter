/**
 * Console-side type declarations.
 *
 * The console deliberately does NOT import `src/lib/types.ts`: the two layers are
 * owned by different work packages and the UI must only depend on the published
 * `/api/admin/**` contract (C3-C8). The shapes below are a faithful transcription
 * of that contract, so a drift in the gateway is caught by the type definitions
 * here and by `tests/ui/*.test.ts`.
 */

/** C6: upstream protocol family. */
export type Protocol = 'anthropic' | 'openai';

export const PROTOCOLS: readonly Protocol[] = ['anthropic', 'openai'];

/** C5: a key as the API exposes it (never the plaintext, never the hash). */
export interface ApiKeyPublic {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** C5: `POST /api/admin/keys` response - the plaintext key is shown exactly once. */
export interface ApiKeyCreated extends ApiKeyPublic {
  /** `ar-<32 hex>`; present only in the creation response. */
  key: string;
}

/** C6: `maskedKey` is always a redacted rendering. */
export interface ProviderPublic {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  enabled: boolean;
  maskedKey: string;
  createdAt: string;
}

/** C6: `POST /api/admin/providers/[id]/test`. */
export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/** C8: one proxied request row. */
export interface RequestLogPublic {
  id: string;
  createdAt: string;
  protocol: Protocol;
  path: string;
  model: string | null;
  upstream: string | null;
  status: number;
  latencyMs: number;
  inputTokens: number | null;
  outputTokens: number | null;
  apiKeyId: string | null;
  error: string | null;
  stream: boolean;
}

/** C7: supported dashboard windows. */
export type StatsRange = '24h' | '7d' | '30d';

export const STATS_RANGES: readonly StatsRange[] = ['24h', '7d', '30d'];

export interface StatsTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** Fraction between 0 and 1, already rounded to four decimals by the API. */
  errorRate: number;
  avgLatencyMs: number;
}

export interface StatsSeriesPoint {
  /** ISO-8601 UTC bucket start. */
  t: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errors: number;
}

export interface StatsByModel {
  model: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
}

export interface StatsByKey {
  apiKeyId: string | null;
  name: string;
  requests: number;
}

/** C7: `GET /api/admin/stats`. */
export interface StatsPayload {
  range: StatsRange;
  totals: StatsTotals;
  series: StatsSeriesPoint[];
  byModel: StatsByModel[];
  byKey: StatsByKey[];
}

/** C4: success envelope. */
export interface DataEnvelope<T> {
  data: T;
}

/** C4: failure envelope. */
export interface ErrorEnvelope {
  error: { message: string };
}

/** C4: list envelope; `nextCursor` is `<created_at>|<id>` for the logs endpoint. */
export interface ListEnvelope<T> {
  data: T[];
  nextCursor?: string | null;
}

/** Payload sent to `POST /api/admin/session` and `POST /api/admin/keys`. */
export interface PasswordPayload {
  password: string;
}

export interface KeyNamePayload {
  name: string;
}

/** Payload for `POST /api/admin/providers` (all fields required except `enabled`). */
export interface CreateProviderPayload {
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
  enabled?: boolean;
}

/** Payload for `PATCH /api/admin/providers/[id]` - every field is optional. */
export interface UpdateProviderPayload {
  name?: string;
  protocol?: Protocol;
  baseUrl?: string;
  /** Omit to keep the stored credential untouched. */
  apiKey?: string;
  enabled?: boolean;
}

/** Client-side filters accepted by `GET /api/admin/logs` (C8). */
export interface LogFilters {
  /** Exact HTTP status code match; empty string means "any". */
  status: string;
  /** Exact model match; empty string means "any". */
  model: string;
}

/** UI-only: theme names persisted to localStorage. */
export type ThemeName = 'dark' | 'light';

/** UI-only: toast severity. */
export type ToastTone = 'success' | 'danger' | 'warning' | 'info';

/* -------------------------------------------------------------------------- */
/* C-AUTH-WIRE / C-USERS-WIRE / C-CAPTCHA - accounts and sessions              */
/* -------------------------------------------------------------------------- */

/** C-DTO: role of a database-backed account. */
export type UserRole = 'admin' | 'member';

export const USER_ROLES: readonly UserRole[] = ['admin', 'member'];

/** C-DTO: only `active` accounts may authenticate. */
export type UserStatus = 'active' | 'disabled';

export const USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'];

/**
 * C-DTO: every user field the API exposes.
 *
 * There is no password field in this shape and there never will be: the console
 * renders whatever `/api/auth/**` and `/api/admin/users/**` send, and the server
 * sends `UserPublic` only.
 */
export interface UserPublic {
  id: string;
  username: string;
  displayName: string | null;
  role: UserRole;
  status: UserStatus;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

/** C-DTO: one device/session as listed on the user detail page. */
export interface UserSessionPublic {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  /** True for the session the requesting console is holding. */
  current: boolean;
}

/** C-DTO: `GET /api/admin/users/[id]` - the account plus its live sessions. */
export interface UserDetailPublic extends UserPublic {
  sessions: UserSessionPublic[];
}

/** C-SETTINGS-WIRE: the registration switch as the UI consumes it. */
export interface RegistrationSetting {
  enabled: boolean;
}

/** C-CAPTCHA: `GET /api/auth/captcha` - the challenge plus its rendered image. */
export interface CaptchaChallengePublic {
  challengeId: string;
  /** `data:image/svg+xml;base64,...` - safe to bind to `<img src>` as-is. */
  imageDataUrl: string;
  expiresAt: string;
}

/** C-AUTH-WIRE: `GET /api/auth/session` (a guest is 200 with `user: null`). */
export interface AuthStatePayload {
  user: UserPublic | null;
  registration: RegistrationSetting;
}

/** Which form the sign-in dialog is showing. */
export type AuthMode = 'login' | 'register';

/** C-AUTH-WIRE: `POST /api/auth/login` body (the captcha answer is mandatory). */
export interface LoginInput {
  username: string;
  password: string;
  challengeId: string;
  captchaAnswer: string;
}

/** C-AUTH-WIRE: `POST /api/auth/register` body (the role is always `member`). */
export interface RegisterInput {
  username: string;
  password: string;
  displayName?: string;
  challengeId: string;
  captchaAnswer: string;
}

/** C-AUTH-WIRE: `POST /api/auth/password` body. */
export interface ChangePasswordInput {
  currentPassword: string;
  newPassword: string;
}

/** C-USERS-WIRE: `POST /api/admin/users` body. */
export interface CreateUserPayload {
  username: string;
  password: string;
  role?: UserRole;
  displayName?: string;
}

/** C-USERS-WIRE: `PATCH /api/admin/users/[id]` body - every field is optional. */
export interface UpdateUserPayload {
  /** `null` clears the display name; omit to keep it. */
  displayName?: string | null;
  role?: UserRole;
  status?: UserStatus;
}

/** C-USERS-WIRE: query parameters of `GET /api/admin/users`. Empty string = "any". */
export interface ListUsersInput {
  limit?: number;
  cursor?: string | null;
  search?: string;
  role?: UserRole | '';
  status?: UserStatus | '';
}

/** C-USERS-WIRE: one keyset page of accounts. */
export interface UsersPage {
  data: UserPublic[];
  nextCursor: string | null;
}
