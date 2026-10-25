import { EncryptionError, newId, open, seal } from '@/lib/crypto';
import { execute, queryAll, queryOne } from '@/lib/db';
import { getProviderTestTimeoutMs } from '@/lib/env';
import type { Protocol, ProviderPublic } from '@/lib/types';
import { isProtocol } from '@/lib/types';
import { MODELS_PATH, joinUpstreamUrl, redactPreview, upstreamAuthHeaders } from '@/lib/upstream';

const NAME_MAX_LENGTH = 64;
const BASE_URL_MAX_LENGTH = 500;
const API_KEY_MAX_LENGTH = 4096;

export interface ProviderRow {
  id: string;
  name: string;
  protocol: Protocol;
  base_url: string;
  api_key_enc: string;
  enabled: number;
  created_at: number;
}

/** Provider plus its decrypted credential, for relay use only. */
export interface RelayProvider {
  id: string;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  apiKey: string;
}

export class ProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderValidationError';
  }
}

/**
 * Shortest credential still identified by its first/last four characters.
 *
 * Below this length the mask hides the whole key instead: revealing eight
 * characters of a nine-character key would hand the console — and anyone reading
 * an admin response or a screenshot of it — a near-complete copy of the upstream
 * secret, which is exactly what C6's `maskedKey` exists to prevent. Real provider
 * credentials (`sk-ant-...`, `sk-proj-...`) are far longer than this.
 */
const MASK_MIN_PARTIAL_LENGTH = 16;

/** Redact an upstream key for display: never returns the full secret. */
export function maskKey(key: string): string {
  if (!key) return '';
  const trimmed = key.trim();
  if (trimmed.length < MASK_MIN_PARTIAL_LENGTH) return '••••';
  return `${trimmed.slice(0, 4)}…${trimmed.slice(-4)}`;
}

function toPublic(row: ProviderRow): ProviderPublic {
  let maskedKey = '••••';
  try {
    maskedKey = maskKey(open(row.api_key_enc));
  } catch (error) {
    if (!(error instanceof EncryptionError)) throw error;
    // Never leak ciphertext or crash a listing because one row cannot be decrypted.
    maskedKey = '••••';
  }
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.base_url,
    enabled: Number(row.enabled) === 1,
    maskedKey,
    createdAt: new Date(Number(row.created_at)).toISOString(),
  };
}

function normalizeName(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderValidationError('name is required and must be a string');
  }
  const name = value.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (name.length === 0) throw new ProviderValidationError('name must not be empty');
  if (name.length > NAME_MAX_LENGTH) {
    throw new ProviderValidationError(`name must be at most ${NAME_MAX_LENGTH} characters`);
  }
  return name;
}

export function normalizeProtocol(value: unknown): Protocol {
  if (!isProtocol(value)) {
    throw new ProviderValidationError("protocol must be 'anthropic' or 'openai'");
  }
  return value;
}

/** Validate and canonicalize an upstream base URL (http/https only). */
export function normalizeBaseUrl(value: unknown): string {
  if (typeof value !== 'string') {
    throw new ProviderValidationError('baseUrl is required and must be a string');
  }
  const raw = value.trim().replace(/\/+$/, '');
  if (raw.length === 0) throw new ProviderValidationError('baseUrl must not be empty');
  if (raw.length > BASE_URL_MAX_LENGTH) {
    throw new ProviderValidationError(`baseUrl must be at most ${BASE_URL_MAX_LENGTH} characters`);
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ProviderValidationError('baseUrl must be an absolute http(s) URL');
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ProviderValidationError('baseUrl must use the http or https scheme');
  }
  if (parsed.username || parsed.password) {
    throw new ProviderValidationError('baseUrl must not contain credentials');
  }
  return raw;
}

/**
 * Validate an upstream credential. Control characters are rejected outright:
 * the value is written into an HTTP header and must never be able to inject one.
 */
export function normalizeApiKey(value: unknown, { required = true }: { required?: boolean } = {}): string | undefined {
  if (value === undefined || value === null) {
    if (required) throw new ProviderValidationError('apiKey is required');
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new ProviderValidationError('apiKey must be a string');
  }
  const key = value.trim();
  if (key.length === 0) {
    if (required) throw new ProviderValidationError('apiKey must not be empty');
    return undefined;
  }
  if (key.length > API_KEY_MAX_LENGTH) {
    throw new ProviderValidationError(`apiKey must be at most ${API_KEY_MAX_LENGTH} characters`);
  }
  if (/[\u0000-\u001f\u007f]/.test(key)) {
    throw new ProviderValidationError('apiKey must not contain control characters');
  }
  return key;
}

function parseEnabled(value: unknown, fallback: boolean): boolean {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  if (value === 1 || value === '1' || value === 'true') return true;
  if (value === 0 || value === '0' || value === 'false') return false;
  throw new ProviderValidationError('enabled must be a boolean');
}

export function listProviders(): ProviderPublic[] {
  const rows = queryAll<ProviderRow>(
    'SELECT * FROM providers ORDER BY created_at DESC, id DESC',
  );
  return rows.map(toPublic);
}

export function getProvider(id: string): ProviderPublic | null {
  const row = queryOne<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
  return row ? toPublic(row) : null;
}

export interface CreateProviderInput {
  name: unknown;
  protocol: unknown;
  baseUrl: unknown;
  apiKey: unknown;
  enabled?: unknown;
}

export function createProvider(input: CreateProviderInput, id: string = newId(), now: number = Date.now()): ProviderPublic {
  const name = normalizeName(input.name);
  const protocol = normalizeProtocol(input.protocol);
  const baseUrl = normalizeBaseUrl(input.baseUrl);
  const apiKey = normalizeApiKey(input.apiKey);
  const enabled = parseEnabled(input.enabled, true);
  execute(
    'INSERT INTO providers (id, name, protocol, base_url, api_key_enc, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [id, name, protocol, baseUrl, seal(apiKey as string), enabled ? 1 : 0, now],
  );
  const row = queryOne<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
  if (!row) throw new Error('failed to persist the provider');
  return toPublic(row);
}

export interface UpdateProviderInput {
  name?: unknown;
  protocol?: unknown;
  baseUrl?: unknown;
  apiKey?: unknown;
  enabled?: unknown;
}

/**
 * Patch a provider. `apiKey` is optional: when omitted the stored ciphertext is
 * kept untouched; when provided it is re-encrypted with a fresh nonce.
 */
export function updateProvider(id: string, patch: UpdateProviderInput): ProviderPublic | null {
  const row = queryOne<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
  if (!row) return null;

  const assignments: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    assignments.push('name = ?');
    params.push(normalizeName(patch.name));
  }
  if (patch.protocol !== undefined) {
    assignments.push('protocol = ?');
    params.push(normalizeProtocol(patch.protocol));
  }
  if (patch.baseUrl !== undefined) {
    assignments.push('base_url = ?');
    params.push(normalizeBaseUrl(patch.baseUrl));
  }
  if (patch.apiKey !== undefined) {
    const apiKey = normalizeApiKey(patch.apiKey, { required: false });
    if (apiKey !== undefined) {
      assignments.push('api_key_enc = ?');
      params.push(seal(apiKey));
    }
  }
  if (patch.enabled !== undefined) {
    assignments.push('enabled = ?');
    params.push(parseEnabled(patch.enabled, true) ? 1 : 0);
  }

  if (assignments.length > 0) {
    params.push(id);
    execute(`UPDATE providers SET ${assignments.join(', ')} WHERE id = ?`, params);
  }
  return getProvider(id);
}

export function deleteProvider(id: string): boolean {
  const result = execute('DELETE FROM providers WHERE id = ?', [id]);
  return result.changes > 0;
}

/**
 * All enabled providers with decrypted credentials (model discovery only).
 * Rows that cannot be decrypted are skipped instead of failing the request.
 */
export function listEnabledProviders(): RelayProvider[] {
  const rows = queryAll<ProviderRow>(
    'SELECT * FROM providers WHERE enabled = 1 ORDER BY created_at ASC, id ASC',
  );
  const result: RelayProvider[] = [];
  for (const row of rows) {
    try {
      result.push({
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        baseUrl: row.base_url,
        apiKey: open(row.api_key_enc),
      });
    } catch {
      // A provider encrypted with a different ENCRYPTION_KEY is simply skipped.
    }
  }
  return result;
}

/**
 * Pick the first enabled provider for a protocol (oldest wins), returning the
 * decrypted credential for the relay.
 */
export function pickProvider(protocol: Protocol): RelayProvider | null {
  const row = queryOne<ProviderRow>(
    'SELECT * FROM providers WHERE protocol = ? AND enabled = 1 ORDER BY created_at ASC, id ASC LIMIT 1',
    [protocol],
  );
  if (!row) return null;
  let apiKey: string;
  try {
    apiKey = open(row.api_key_enc);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ProviderValidationError(
      `provider "${row.name}" cannot be used: ${reason}. Re-save its upstream key in the console.`,
    );
  }
  return { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url, apiKey };
}

/**
 * Fetch the current provider row and decrypt it (used by the "test" endpoint).
 */
export function getRelayProvider(id: string): RelayProvider | null {
  const row = queryOne<ProviderRow>('SELECT * FROM providers WHERE id = ?', [id]);
  if (!row) return null;
  let apiKey: string;
  try {
    apiKey = open(row.api_key_enc);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown error';
    throw new ProviderValidationError(
      `provider "${row.name}" cannot be used: ${reason}. Re-save its upstream key in the console.`,
    );
  }
  return { id: row.id, name: row.name, protocol: row.protocol, baseUrl: row.base_url, apiKey };
}

export interface ProviderTestResult {
  ok: boolean;
  message: string;
}

/**
 * Probe `{baseUrl}/v1/models` with the stored credentials and a 5 second budget.
 * Never throws and never echoes the credential: every upstream-derived string
 * (error body preview, status text, transport error) is run through
 * `redactPreview` before it is returned to the console.
 */
export async function testProviderConnection(
  provider: RelayProvider,
  fetchImpl: typeof fetch = fetch,
): Promise<ProviderTestResult> {
  const url = joinUpstreamUrl(provider.baseUrl, MODELS_PATH);
  const headers: Record<string, string> = {
    accept: 'application/json',
    ...upstreamAuthHeaders(provider.protocol, provider.apiKey),
  };
  const timeoutMs = getProviderTestTimeoutMs();
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(timeoutMs),
      cache: 'no-store',
    });
    if (!response.ok) {
      let detail = '';
      try {
        const text = await response.text();
        // A hostile (or merely careless) upstream may echo the credential it
        // received; this message is served to the console, so scrub first.
        detail = redactPreview(text, [provider.apiKey], 200);
      } catch {
        detail = '';
      }
      const suffix = detail ? `: ${detail}` : '';
      // Redact the composed line as well: `statusText` is upstream-controlled.
      return {
        ok: false,
        message: redactPreview(
          `upstream responded ${response.status} ${response.statusText}`.trim() + suffix,
          [provider.apiKey],
          400,
        ),
      };
    }
    let count: number | null = null;
    try {
      const payload = (await response.json()) as { data?: unknown[] };
      if (Array.isArray(payload?.data)) count = payload.data.length;
    } catch {
      // A null-body status (204/205/304) has no JSON to parse, and a non-JSON body
      // must not fail the probe either: the upstream *is* reachable. `count` stays
      // null so the message reports the real status instead of claiming a model
      // list that was never sent.
      count = null;
    }
    return {
      ok: true,
      message:
        count === null
          ? `upstream reachable: GET /v1/models returned ${response.status}`
          : `upstream reachable: GET /v1/models returned ${count} model${count === 1 ? '' : 's'}`,
    };
  } catch (error) {
    const name = error instanceof Error ? error.name : '';
    const message = error instanceof Error ? error.message : String(error);
    if (name === 'TimeoutError' || /timed? ?out/i.test(message)) {
      return { ok: false, message: `upstream did not answer within ${timeoutMs} ms` };
    }
    return { ok: false, message: redactPreview(`upstream unreachable: ${message}`, [provider.apiKey], 400) };
  }
}
