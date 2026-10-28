/**
 * Shared public types (C4-C8). These describe the JSON shapes returned by the API
 * and are imported by both the gateway and the console UI.
 */

export type Protocol = 'anthropic' | 'openai';

/** C5: never contains the plaintext key or its hash. */
export interface ApiKeyPublic {
  id: string;
  name: string;
  keyPrefix: string;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

/** C5 response for `POST /api/admin/keys`: plaintext key is returned exactly once. */
export interface ApiKeyCreated extends ApiKeyPublic {
  key: string;
}

/** C6: `maskedKey` is always a redacted rendering, never the upstream secret. */
export interface ProviderPublic {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  enabled: boolean;
  maskedKey: string;
  createdAt: string;
}

/** C8: one proxied request. */
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

/** C7 */
export type StatsRange = '24h' | '7d' | '30d';

export interface StatsTotals {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  errorRate: number;
  avgLatencyMs: number;
}

export interface StatsSeriesPoint {
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

/** C-DTO: role of a database-backed account. */
export type UserRole = 'admin' | 'member';

/** C-DTO: only `active` accounts may authenticate. */
export type UserStatus = 'active' | 'disabled';

export const USER_ROLES: readonly UserRole[] = ['admin', 'member'] as const;
export const USER_STATUSES: readonly UserStatus[] = ['active', 'disabled'] as const;

/** C-SCHEMA: `settings.registration_enabled`, a missing row means "open". */
export const REGISTRATION_ENABLED_KEY = 'registration_enabled';

/** C-DTO: every user field the API may expose. Never the password hash. */
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

/** C-DTO: one device/session as shown in the console. */
export interface UserSessionPublic {
  id: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent: string | null;
  ip: string | null;
  current: boolean;
}

/** C-DTO: user plus the sessions the console lists on the detail page. */
export interface UserDetailPublic extends UserPublic {
  sessions: UserSessionPublic[];
}

/** C-GUARD: the authenticated actor a route handler receives. */
export interface AuthContext {
  session: {
    id: string;
    userId: string;
    createdAt: string;
    lastSeenAt: string;
    expiresAt: string;
    userAgent: string | null;
    ip: string | null;
  };
  user: {
    id: string;
    username: string;
    role: UserRole;
    status: UserStatus;
  };
}

/** C-CAPTCHA: what `GET /api/auth/captcha` returns. */
export interface CaptchaChallengePublic {
  challengeId: string;
  imageDataUrl: string;
  expiresAt: string;
}

/** C-DTO: `registration_enabled` as the UI consumes it. */
export interface RegistrationSetting {
  enabled: boolean;
}

/** C4: failure envelope. */
export interface ErrorEnvelope {
  error: { message: string };
}

/** C4: list envelope. */
export interface ListEnvelope<T> {
  data: T[];
  nextCursor?: string | null;
}

/** C2: client-facing error body (Anthropic-compatible). */
export interface ClientErrorBody {
  type: 'error';
  error: { type: string; message: string };
}

/** Upstream protocols the relay understands. */
export const PROTOCOLS: readonly Protocol[] = ['anthropic', 'openai'] as const;

export function isProtocol(value: unknown): value is Protocol {
  return value === 'anthropic' || value === 'openai';
}
