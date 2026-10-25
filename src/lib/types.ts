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
