import { getAnthropicDefaultVersion } from '@/lib/env';
import type { Protocol } from '@/lib/types';

/** Request paths per protocol (C9). */
export const RELAY_PATHS: Record<Protocol, string> = {
  anthropic: '/v1/messages',
  openai: '/v1/chat/completions',
};

export const MODELS_PATH = '/v1/models';

/**
 * Inbound headers that must never reach an upstream:
 * client credentials, hop-by-hop headers and anything host/body related.
 */
export const STRIPPED_INBOUND_HEADERS = [
  'authorization',
  'x-api-key',
  'proxy-authorization',
  'cookie',
  'host',
  'connection',
  'keep-alive',
  'transfer-encoding',
  'content-length',
  'content-encoding',
  'accept-encoding',
  'te',
  'trailer',
  'upgrade',
  'expect',
] as const;

/** Response headers that must not be forwarded verbatim. */
export const STRIPPED_RESPONSE_HEADERS = [
  'content-encoding',
  'content-length',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'set-cookie',
] as const;

/**
 * Join a provider `baseUrl` with a protocol path without duplicating `/v1`.
 * `https://api.anthropic.com` + `/v1/messages` -> `https://api.anthropic.com/v1/messages`
 * `https://host/v1`            + `/v1/messages` -> `https://host/v1/messages`
 */
export function joinUpstreamUrl(baseUrl: string, path: string): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const relative = path.startsWith('/') ? path : `/${path}`;
  if (base.endsWith('/v1') && relative.startsWith('/v1/')) {
    return `${base}${relative.slice(3)}`;
  }
  if (base.endsWith('/v1') && relative === '/v1') {
    return base;
  }
  return `${base}${relative}`;
}

/** Credential headers injected per protocol (C9). */
export function upstreamAuthHeaders(
  protocol: Protocol,
  apiKey: string,
  inbound?: Headers,
): Record<string, string> {
  if (protocol === 'anthropic') {
    const version = inbound?.get('anthropic-version')?.trim() || getAnthropicDefaultVersion();
    return {
      'x-api-key': apiKey,
      'anthropic-version': version,
    };
  }
  return {
    authorization: `Bearer ${apiKey}`,
  };
}

function isStripped(name: string): boolean {
  const lower = name.toLowerCase();
  return (STRIPPED_INBOUND_HEADERS as readonly string[]).includes(lower);
}

/**
 * Build the header set sent upstream: client headers minus credentials and
 * hop-by-hop fields, plus the provider credentials for `protocol`.
 *
 * `stream` is the relay's resolved decision (an explicit `body.stream` wins over
 * the inbound `Accept` header, see `wantsStream`), so the upstream is always told
 * what the gateway actually expects back. Without this a client that sends only
 * `{"stream": true}` and no `Accept` header — the common SDK shape — would be
 * served as SSE while the upstream was asked for JSON.
 */
export function buildUpstreamHeaders(
  protocol: Protocol,
  apiKey: string,
  inbound: Headers,
  stream = false,
): Headers {
  const headers = new Headers();
  inbound.forEach((value, name) => {
    if (isStripped(name)) return;
    try {
      headers.set(name, value);
    } catch {
      // ignore header values that are not representable upstream
    }
  });
  headers.set('content-type', 'application/json');
  // `stream` is already the resolved decision (an explicit `body.stream` wins over
  // the inbound `Accept` header — see `wantsStream`), so deriving the header from
  // it alone keeps the two in sync in both directions: no `Accept` header with
  // `body.stream: true`, and no SSE request behind an `Accept: text/event-stream`
  // header paired with `body.stream: false`.
  headers.set('accept', stream ? 'text/event-stream' : 'application/json');
  for (const [name, value] of Object.entries(upstreamAuthHeaders(protocol, apiKey, inbound))) {
    headers.set(name, value);
  }
  return headers;
}

/** Marker substituted for a credential that would otherwise be echoed. */
export const REDACTED_PLACEHOLDER = '[redacted]';

/**
 * A value shorter than this is only redacted on token boundaries: replacing a
 * two character needle everywhere would destroy the surrounding message.
 */
const MIN_SUBSTRING_REDACT_LENGTH = 4;

/**
 * Token shapes that always look like a credential, independent of whether we
 * know the secret. Applied as defence in depth for upstreams that answer with
 * `Authorization: Bearer <token>` style diagnostics.
 */
const BEARER_TOKEN_PATTERN =
  /(\bbearer\s+)(?=[A-Za-z0-9._~+/=-]*[0-9._~+/=-])[A-Za-z0-9._~+/=-]{8,}/gi;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Plain, percent-encoded and JSON-escaped renderings of one secret. */
function secretVariants(secret: string): string[] {
  const variants = new Set<string>();
  variants.add(secret);
  const escaped = JSON.stringify(secret);
  if (escaped.length > 2) variants.add(escaped.slice(1, -1));
  try {
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) variants.add(encoded);
  } catch {
    // encodeURIComponent throws on lone surrogates; the raw variant still covers it.
  }
  return [...variants];
}

/**
 * Remove every occurrence of the given credentials from `text`.
 *
 * Upstreams (and self-hosted gateways in particular) sometimes echo the
 * `x-api-key` / `Authorization` value back inside an error body. That text ends
 * up in an admin-visible `message` or in `request_logs.error`, so it must be
 * scrubbed before it is stored or returned: no admin response may ever contain
 * an upstream plaintext key.
 */
export function redactSecrets(text: string, secrets: Array<string | null | undefined>): string {
  if (!text) return text;
  let result = text;
  const seen = new Set<string>();
  for (const raw of secrets) {
    if (typeof raw !== 'string') continue;
    const secret = raw.trim();
    if (secret.length === 0) continue;
    for (const variant of secretVariants(secret)) {
      if (seen.has(variant)) continue;
      seen.add(variant);
      if (variant.length >= MIN_SUBSTRING_REDACT_LENGTH) {
        result = result.replace(new RegExp(escapeRegExp(variant), 'gi'), REDACTED_PLACEHOLDER);
      } else {
        // Short secret: only replace it when it stands alone as a token.
        result = result.replace(
          new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(variant)}(?![A-Za-z0-9])`, 'g'),
          REDACTED_PLACEHOLDER,
        );
      }
    }
  }
  return result.replace(BEARER_TOKEN_PATTERN, `$1${REDACTED_PLACEHOLDER}`);
}

/**
 * Redact, flatten to a single line and cut to `limit` characters — the exact
 * shape stored in `request_logs.error` / returned by the provider test.
 * Redaction runs before truncation so a cut can never expose a key prefix.
 */
export function redactPreview(
  text: string,
  secrets: Array<string | null | undefined>,
  limit: number,
  fallback = '',
): string {
  const flattened = redactSecrets(text, secrets).replace(/\s+/g, ' ').trim();
  const sliced = flattened.slice(0, Math.max(0, limit));
  return sliced || fallback;
}

/** Copy upstream response headers while dropping transport-level ones. */
export function buildClientHeaders(upstream: Headers, stream: boolean): Headers {
  const headers = new Headers();
  const stripped = STRIPPED_RESPONSE_HEADERS as readonly string[];
  upstream.forEach((value, name) => {
    const lower = name.toLowerCase();
    if (stripped.includes(lower)) return;
    try {
      headers.set(name, value);
    } catch {
      // ignore
    }
  });
  if (!headers.has('content-type')) {
    headers.set('content-type', stream ? 'text/event-stream; charset=utf-8' : 'application/json');
  }
  if (stream) {
    headers.set('cache-control', 'no-cache, no-transform');
    headers.set('x-accel-buffering', 'no');
  }
  return headers;
}

/**
 * True when the client asked for server-sent events.
 * An explicit `stream` field in the JSON body always wins; otherwise the
 * `Accept` header decides.
 */
export function wantsStream(body: unknown, request: Request): boolean {
  if (body && typeof body === 'object' && 'stream' in body) {
    return (body as { stream?: unknown }).stream === true;
  }
  return (request.headers.get('accept') ?? '').includes('text/event-stream');
}
