import { clientError } from '@/lib/api-helpers';
import { getMaxBufferedResponseBytes, getRelayTimeoutMs } from '@/lib/env';
import { insertRequestLog } from '@/lib/logs';
import { pickProvider, type RelayProvider } from '@/lib/providers';
import type { Protocol } from '@/lib/types';
import {
  RELAY_PATHS,
  buildClientHeaders,
  buildUpstreamHeaders,
  joinUpstreamUrl,
  redactPreview,
  redactSecrets,
  wantsStream,
} from '@/lib/upstream';

/** Token/model figures observed on an upstream response. */
export interface UsageSnapshot {
  inputTokens: number;
  outputTokens: number;
  model: string | null;
}

/** The row that will be written to `request_logs` (C8 / C12). */
export interface RelayLogDraft {
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

export interface RelayResult {
  response: Response;
  /**
   * For `stream: true` this object is still live when the call returns: the
   * stream transformer fills in latency, tokens and error state while the bytes
   * flow through, and persists the row when the stream flushes.
   */
  log: RelayLogDraft;
  provider: { id: string; name: string } | null;
}

export interface RelayOptions {
  protocol: Protocol;
  request: Request;
  body: Record<string, unknown>;
  apiKeyId?: string | null;
  /** Injection point for tests (defaults to the global `fetch`). */
  fetchImpl?: typeof fetch;
}

const ERROR_PREVIEW_LIMIT = 800;
/**
 * Upper bound (in characters) for an upstream *error* body that is buffered so
 * it can be redacted before it is handed to the client. Error payloads are small
 * (a few hundred bytes); the cap only exists so a hostile upstream cannot make
 * the gateway buffer without limit. A body that exceeds it is not forwarded at
 * all (see `bufferErrorBody`), because a cut could split the credential so it no
 * longer matches the redaction.
 */
const ERROR_BODY_BUFFER_LIMIT = 256 * 1024;
const MAX_SSE_BUFFER = 1_000_000;
const MODEL_MAX_LENGTH = 200;

/**
 * Statuses the Fetch standard defines as *null body* statuses.
 *
 * A `Response` for one of them can never carry a body, and
 * `new Response(body, { status: 204 })` throws a `TypeError` even when `body` is
 * a zero-length `Uint8Array`. Forwarding the (empty) upstream buffer therefore
 * made the relay throw on a perfectly valid upstream answer, and the route's
 * `catch` turned it into a 502 while `request_logs` already held the upstream
 * status with `error = null` — a self-contradicting pair for whoever reads the
 * console.
 */
const NULL_BODY_STATUSES: readonly number[] = [204, 205, 304];

/** True when `status` cannot carry a response body (204 / 205 / 304). */
export function hasNullBodyStatus(status: number): boolean {
  return NULL_BODY_STATUSES.includes(status);
}

/**
 * Status range the `Response` constructor accepts (200-599 inclusive).
 *
 * The null-body defect above was one instance of a general rule: `relay()` must
 * never build a `Response` from an upstream answer it cannot represent, because
 * the row in `request_logs` is already being written with the upstream status.
 * A `Response` also throws a `RangeError` for any status outside this range — a
 * 1xx interim status leaked by a proxy, a non-HTTP status such as `0`, or a bogus
 * 6xx — so an answer like that is rejected up front: the client gets a 502 *and*
 * the row records that same 502, instead of a 502 paired with the upstream status.
 */
export const RESPONSE_STATUS_MIN = 200;
export const RESPONSE_STATUS_MAX = 599;

/** True when the Fetch `Response` constructor accepts `status`. */
export function isRelayableStatus(status: number): boolean {
  return Number.isInteger(status) && status >= RESPONSE_STATUS_MIN && status <= RESPONSE_STATUS_MAX;
}

/**
 * Headers that announce a payload. A null-body response cannot carry one, so
 * they are dropped instead of being advertised to a client SDK that would then
 * wait for — or try to parse — a body that can never arrive.
 */
const PAYLOAD_HEADERS: readonly string[] = [
  'content-type',
  'content-encoding',
  'content-length',
  'content-range',
  'trailer',
  'transfer-encoding',
];

/**
 * Build the `Response` handed back to the client.
 *
 * The body is `null` for a null-body status (204/205/304) — the only shape those
 * statuses accept — and for an empty buffer, which states "there is no payload"
 * unambiguously. Every response the relay creates goes through here, so no code
 * path can reintroduce the body-on-204 `TypeError`, and the status the client
 * receives is always the status the log row records.
 *
 * `status` must already be one the constructor accepts: `relay` rejects an
 * upstream answer outside 200-599 with a logged 502 (see `isRelayableStatus`)
 * before any `Response` is built, so this function can never throw a `RangeError`
 * after a row has been persisted.
 */
function relayResponse(
  status: number,
  statusText: string,
  headers: Headers,
  body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null,
): Response {
  const nullBody = hasNullBodyStatus(status);
  if (nullBody) {
    for (const name of PAYLOAD_HEADERS) headers.delete(name);
  }
  const payload = nullBody || isEmptyBody(body) ? null : body;
  return new Response(payload, { status, statusText, headers });
}

/** True when `body` carries no bytes (a zero-length buffer or nothing at all). */
function isEmptyBody(body: Uint8Array<ArrayBuffer> | ReadableStream<Uint8Array> | null): boolean {
  if (body === null) return true;
  return body instanceof Uint8Array && body.byteLength === 0;
}

/**
 * Release an upstream body the relay is not going to consume, so a null-body
 * status does not leave a response body dangling on the connection.
 */
async function cancelUpstreamBody(body: ReadableStream<Uint8Array> | null): Promise<void> {
  if (!body) return;
  try {
    await body.cancel();
  } catch {
    // already closed or errored: nothing to release
  }
}

interface BufferedErrorBody {
  text: string;
  /** False when the body was cut short or the upstream stream failed. */
  complete: boolean;
}

/**
 * Outcome of buffering a *successful* non-streaming upstream body.
 *
 * `buffered` carries the complete body (needed for usage extraction and for
 * byte-for-byte replay). `passthrough` is used when the body exceeds the memory
 * budget: the already-read prefix is replayed and the remainder is streamed, so a
 * hostile upstream cannot make the gateway buffer without limit and the client
 * still receives every byte.
 */
type SuccessBody =
  | { kind: 'buffered'; bytes: Uint8Array }
  | { kind: 'passthrough'; stream: ReadableStream<Uint8Array> };

/**
 * Buffer an upstream success body up to `limitBytes`. Anything larger is handed
 * back as a stream starting with the bytes already consumed, so nothing is lost
 * and nothing unbounded is held in memory.
 */
async function bufferSuccessBody(
  body: ReadableStream<Uint8Array>,
  limitBytes: number,
): Promise<SuccessBody> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    total += value.byteLength;
    if (total > limitBytes) {
      // Over budget: replay what we hold and keep streaming from the same reader.
      return {
        kind: 'passthrough',
        stream: new ReadableStream<Uint8Array>({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.enqueue(value);
          },
          async pull(controller) {
            try {
              const next = await reader.read();
              if (next.done) {
                controller.close();
                return;
              }
              if (next.value) controller.enqueue(next.value);
            } catch (error) {
              controller.error(error);
            }
          },
          cancel(reason) {
            reader.cancel(reason).catch(() => undefined);
          },
        }),
      };
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { kind: 'buffered', bytes: merged };
}

/**
 * Buffer an upstream error body (bounded) so it can be scrubbed before it is
 * forwarded. A partial body is never forwarded: `complete === false` forces the
 * caller to answer with a synthetic error instead of upstream bytes.
 *
 * `redactReason` keeps the diagnostic out of the server log unredacted: an
 * upstream reset message can quote the credential it was rejected with.
 */
async function bufferErrorBody(
  body: ReadableStream<Uint8Array>,
  redactReason: (value: string) => string,
): Promise<BufferedErrorBody> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let text = '';
  let complete = true;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      text += decoder.decode(value, { stream: true });
      if (text.length > ERROR_BODY_BUFFER_LIMIT) {
        // Too large to reason about safely: stop reading and let the caller answer
        // with a synthetic error instead of (possibly cut) upstream bytes.
        complete = false;
        text = text.slice(0, ERROR_BODY_BUFFER_LIMIT);
        break;
      }
    }
    if (complete) text += decoder.decode();
  } catch (error) {
    // Reading the error body failed (reset, timeout, client gone). Keep whatever
    // was decoded, but never relay an unscrubbed/partial body.
    complete = false;
    console.error('[relay] unable to buffer the upstream error body:', redactReason(String(error)));
  } finally {
    try {
      await reader.cancel();
    } catch {
      // already closed / errored
    }
  }
  return { text, complete };
}

/**
 * Reason phrases must stay printable ASCII, and a hostile upstream must not be
 * able to echo its credential through `statusText` on the way to the client.
 */
function clientStatusText(statusText: string, secrets: Array<string | null | undefined>): string {
  const redacted = redactSecrets(statusText ?? '', secrets);
  // eslint-disable-next-line no-control-regex
  return redacted.replace(/[^\t\x20-\x7e\x80-\xff]/g, ' ').trim();
}

/**
 * Defence in depth: scrub credentials out of forwarded response header values so
 * an upstream that reflects its key in a header cannot hand it to the client.
 */
function redactHeaderValues(headers: Headers, secrets: Array<string | null | undefined>): void {
  for (const [name, value] of Array.from(headers.entries())) {
    const redacted = redactSecrets(value, secrets);
    if (redacted !== value) headers.set(name, redacted);
  }
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value) && value >= 0) return Math.trunc(value);
  return null;
}

function mergeUsage(snapshot: UsageSnapshot, usage: unknown): void {
  if (!usage || typeof usage !== 'object') return;
  const record = usage as Record<string, unknown>;
  const input = readFiniteNumber(record.input_tokens) ?? readFiniteNumber(record.prompt_tokens);
  const output = readFiniteNumber(record.output_tokens) ?? readFiniteNumber(record.completion_tokens);
  if (input !== null) snapshot.inputTokens = Math.max(snapshot.inputTokens, input);
  if (output !== null) snapshot.outputTokens = Math.max(snapshot.outputTokens, output);
}

function mergeModel(snapshot: UsageSnapshot, value: unknown): void {
  if (typeof value === 'string' && value.length > 0) {
    snapshot.model = value.slice(0, MODEL_MAX_LENGTH);
  }
}

/**
 * Apply one SSE `data:` payload to the usage snapshot.
 * Handles Anthropic `message_start` / `message_delta` and OpenAI usage chunks.
 */
export function applySseData(protocol: Protocol, data: string, snapshot: UsageSnapshot): void {
  if (!data || data === '[DONE]') return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  const event = parsed as Record<string, unknown>;
  mergeModel(snapshot, event.model);
  if (protocol === 'anthropic') {
    const message = event.message;
    if (message && typeof message === 'object') {
      const messageRecord = message as Record<string, unknown>;
      mergeModel(snapshot, messageRecord.model);
      mergeUsage(snapshot, messageRecord.usage);
    }
  }
  mergeUsage(snapshot, event.usage);
}

/** Extract usage (and model) from a buffered JSON response body. */
export function parseUsageFromJson(protocol: Protocol, text: string): UsageSnapshot {
  const snapshot: UsageSnapshot = { inputTokens: 0, outputTokens: 0, model: null };
  if (!text) return snapshot;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return snapshot;
  }
  if (!parsed || typeof parsed !== 'object') return snapshot;
  const record = parsed as Record<string, unknown>;
  mergeModel(snapshot, record.model);
  if (protocol === 'anthropic') {
    const message = record.message;
    if (message && typeof message === 'object') {
      mergeUsage(snapshot, (message as Record<string, unknown>).usage);
    }
  }
  mergeUsage(snapshot, record.usage);
  return snapshot;
}

function modelFromBody(body: Record<string, unknown>): string | null {
  const model = body.model;
  return typeof model === 'string' && model.length > 0 ? model.slice(0, MODEL_MAX_LENGTH) : null;
}

function persistLog(draft: RelayLogDraft): void {
  try {
    insertRequestLog({
      protocol: draft.protocol,
      path: draft.path,
      model: draft.model,
      upstream: draft.upstream,
      status: draft.status,
      latencyMs: draft.latencyMs,
      inputTokens: draft.inputTokens,
      outputTokens: draft.outputTokens,
      apiKeyId: draft.apiKeyId,
      error: draft.error,
      stream: draft.stream,
    });
  } catch (error) {
    // Logging must never corrupt or delay the proxied response.
    console.error('[relay] unable to persist request log:', error);
  }
}

function buildSignal(request: Request): AbortSignal | undefined {
  const timeoutMs = getRelayTimeoutMs();
  const signals: AbortSignal[] = [AbortSignal.timeout(timeoutMs)];
  if (request.signal) signals.push(request.signal);
  const anySignal = (AbortSignal as unknown as { any?: (signals: AbortSignal[]) => AbortSignal }).any;
  if (typeof anySignal === 'function') return anySignal(signals);
  return signals[0];
}

function describeFetchError(error: unknown): { status: number; message: string; type: string } {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'TimeoutError' || name === 'AbortError' || /timed? ?out|aborted/i.test(message)) {
    return { status: 504, message: 'upstream request timed out', type: 'timeout_error' };
  }
  return { status: 502, message: `upstream request failed: ${message}`, type: 'api_error' };
}

/**
 * Proxy one client call to the configured upstream (C9).
 *
 * - resolves the first enabled provider for the protocol;
 * - strips client credentials and injects the provider credential;
 * - `stream: true` pipes upstream bytes through untouched via `TransformStream`
 *   (no whole-body buffering) and writes the log row on flush;
 * - non-stream responses are forwarded byte-for-byte after usage extraction.
 */
export async function relay(options: RelayOptions): Promise<RelayResult> {
  const { protocol, request, body } = options;
  const fetchImpl = options.fetchImpl ?? fetch;
  const path = RELAY_PATHS[protocol];
  const stream = wantsStream(body, request);
  const apiKeyId = options.apiKeyId ?? null;
  const startedAt = Date.now();

  let provider: RelayProvider | null = null;
  try {
    provider = pickProvider(protocol);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'provider configuration error';
    const draft: RelayLogDraft = {
      protocol,
      path,
      model: modelFromBody(body),
      upstream: null,
      status: 500,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      apiKeyId,
      error: message,
      stream,
    };
    draft.latencyMs = Date.now() - startedAt;
    persistLog(draft);
    return { response: clientError(message, 500, 'api_error'), log: draft, provider: null };
  }

  if (!provider) {
    const message = `no enabled ${protocol} provider is configured`;
    const draft: RelayLogDraft = {
      protocol,
      path,
      model: modelFromBody(body),
      upstream: null,
      status: 503,
      latencyMs: 0,
      inputTokens: null,
      outputTokens: null,
      apiKeyId,
      error: message,
      stream,
    };
    draft.latencyMs = Date.now() - startedAt;
    persistLog(draft);
    return { response: clientError(message, 503, 'api_error'), log: draft, provider: null };
  }

  // The credential never leaves this function: anything derived from an upstream
  // response is scrubbed with it before it can reach a log, an admin response or
  // a body/header served to a client (`ar-...` holders have the lowest privilege).
  const upstreamApiKey = provider.apiKey;
  const redactError = (value: string): string => redactSecrets(value, [upstreamApiKey]);

  const upstreamUrl = joinUpstreamUrl(provider.baseUrl, path);
  const headers = buildUpstreamHeaders(protocol, provider.apiKey, request.headers, stream);
  const payload = JSON.stringify(body);

  let upstream: Response;
  try {
    upstream = await fetchImpl(upstreamUrl, {
      method: 'POST',
      headers,
      body: payload,
      signal: buildSignal(request) ?? null,
      cache: 'no-store',
    });
  } catch (error) {
    const described = describeFetchError(error);
    described.message = redactError(described.message);
    const draft: RelayLogDraft = {
      protocol,
      path,
      model: modelFromBody(body),
      upstream: provider.name,
      status: described.status,
      latencyMs: Date.now() - startedAt,
      inputTokens: null,
      outputTokens: null,
      apiKeyId,
      error: described.message,
      stream,
    };
    persistLog(draft);
    return { response: clientError(described.message, described.status, described.type), log: draft, provider };
  }

  const providerInfo = { id: provider.id, name: provider.name };

  if (!isRelayableStatus(upstream.status)) {
    // Defence in depth for the class of defect the null-body fix belongs to: a
    // status the `Response` constructor cannot carry would make `relayResponse`
    // throw, and the route's `catch` would answer 502 while the row kept the
    // upstream status — the very contradiction the WP removes. Reject the answer
    // here instead, so the status the client receives and the status recorded in
    // `request_logs` are the same 502 and the row carries a diagnostic rather than
    // `error = null`.
    await cancelUpstreamBody(upstream.body);
    const message = `upstream returned HTTP status ${upstream.status}, which cannot be relayed`;
    const draft: RelayLogDraft = {
      protocol,
      path,
      model: modelFromBody(body),
      upstream: provider.name,
      status: 502,
      latencyMs: Date.now() - startedAt,
      inputTokens: null,
      outputTokens: null,
      apiKeyId,
      error: message,
      stream,
    };
    persistLog(draft);
    return {
      response: clientError(message, 502, 'api_error'),
      log: draft,
      provider: providerInfo,
    };
  }

  const responseHeaders = buildClientHeaders(upstream.headers, stream);
  redactHeaderValues(responseHeaders, [upstreamApiKey]);
  // C9: a `stream: true` call is answered as SSE even when a (mis)configured
  // upstream labelled its successful body differently — the client asked for an
  // event stream, and `buildClientHeaders` only fills the type in when the
  // upstream sent none. Error statuses keep the upstream type (a JSON error body
  // must not be advertised as SSE), and a null-body status (204/205/304) carries
  // no payload at all, so it never gets an event-stream label.
  if (stream && upstream.ok && !hasNullBodyStatus(upstream.status)) {
    responseHeaders.set('content-type', 'text/event-stream; charset=utf-8');
  }
  const bodyModel = modelFromBody(body);
  // A hostile upstream could echo the credential in the reason phrase too.
  const statusText = clientStatusText(upstream.statusText, [upstreamApiKey]);

  if (!stream) {
    // A successful body is buffered so it can be replayed byte-for-byte (usage
    // extraction needs it anyway). The buffer is bounded: a body over the budget
    // is streamed through instead of held in memory, so a hostile upstream cannot
    // exhaust the gateway. An *error* body goes through the bounded reader the
    // streaming path uses: small payloads only, and the cap keeps a hostile
    // upstream from exhausting memory with a huge error page.
    const isError = upstream.status >= 400;
    // 204/205/304 carry no payload: buffering them is pointless, and forwarding a
    // body for them is illegal (see `relayResponse`).
    const nullBody = hasNullBodyStatus(upstream.status);
    let bytes: Uint8Array | null = null;
    let text = '';
    let errorComplete = true;
    let oversizeStream: ReadableStream<Uint8Array> | null = null;
    if (nullBody) {
      // A non-null body on a null-body status would be a protocol violation;
      // release it instead of holding the connection open.
      await cancelUpstreamBody(upstream.body);
    } else if (isError) {
      if (upstream.body) {
        const buffered = await bufferErrorBody(upstream.body, redactError);
        text = buffered.text;
        errorComplete = buffered.complete;
      }
    } else {
      try {
        const buffered: SuccessBody = upstream.body
          ? await bufferSuccessBody(upstream.body, getMaxBufferedResponseBytes())
          : { kind: 'buffered', bytes: new Uint8Array(0) };
        if (buffered.kind === 'passthrough') {
          oversizeStream = buffered.stream;
        } else {
          bytes = buffered.bytes;
          text = new TextDecoder().decode(buffered.bytes);
        }
      } catch (error) {
        const described = describeFetchError(error);
        described.message = redactError(described.message);
        const draft: RelayLogDraft = {
          protocol,
          path,
          model: bodyModel,
          upstream: provider.name,
          status: described.status,
          latencyMs: Date.now() - startedAt,
          inputTokens: null,
          outputTokens: null,
          apiKeyId,
          error: described.message,
          stream,
        };
        persistLog(draft);
        return { response: clientError(described.message, described.status, described.type), log: draft, provider: providerInfo };
      }
    }

    if (oversizeStream) {
      // Over the buffering budget: pass the body through untouched (prefix already
      // replayed by `bufferSuccessBody`) and log the call without token counts,
      // which cannot be extracted without buffering.
      const draft: RelayLogDraft = {
        protocol,
        path,
        model: bodyModel,
        upstream: provider.name,
        status: upstream.status,
        latencyMs: Date.now() - startedAt,
        inputTokens: null,
        outputTokens: null,
        apiKeyId,
        error: null,
        stream,
      };
      persistLog(draft);
      return {
        response: relayResponse(upstream.status, statusText, responseHeaders, oversizeStream),
        log: draft,
        provider: providerInfo,
      };
    }

    const usage = parseUsageFromJson(protocol, text);
    const draft: RelayLogDraft = {
      protocol,
      path,
      model: usage.model ?? bodyModel,
      upstream: provider.name,
      status: upstream.status,
      latencyMs: Date.now() - startedAt,
      inputTokens: usage.inputTokens > 0 ? usage.inputTokens : null,
      outputTokens: usage.outputTokens > 0 ? usage.outputTokens : null,
      apiKeyId,
      error: isError
        ? redactPreview(text, [upstreamApiKey], ERROR_PREVIEW_LIMIT, `upstream responded ${upstream.status}`)
        : null,
      stream,
    };
    persistLog(draft);

    if (isError && (!errorComplete || text.trim().length === 0)) {
      // A cut error body could split the credential so it no longer matches the
      // redaction: answer with a synthetic, credential-free error instead. The log
      // row keeps the (redacted) preview for diagnostics. An upstream error with no
      // usable body at all is answered the same way: a bare status with an empty
      // body gives a client SDK nothing to report (every error path must stay a
      // structured, actionable `{type,error{type,message}}` body).
      return {
        response: clientError(`upstream responded ${upstream.status}`, upstream.status, 'api_error'),
        log: draft,
        provider: providerInfo,
      };
    }

    // C9's byte-for-byte passthrough covers *successful* calls. An upstream error
    // body is not part of that contract, and an upstream (a self-hosted gateway in
    // particular) may echo the x-api-key / Authorization value it was given inside
    // that body. The client holds the lowest-privilege credential (`ar-...`), so
    // forwarding the echo verbatim would hand it the operator's upstream key and
    // let it bypass this gateway's quota and revocation. Redact before returning.
    const clientBody: Uint8Array<ArrayBuffer> | null = nullBody
      ? null
      : isError
        ? new TextEncoder().encode(redactSecrets(text, [upstreamApiKey]))
        : (bytes as Uint8Array<ArrayBuffer> | null);
    return {
      // `relayResponse` keeps a null-body status body-less, so the client receives
      // exactly the status recorded in the row above instead of a 502 born from a
      // `Response` constructor `TypeError`.
      response: relayResponse(upstream.status, statusText, responseHeaders, clientBody),
      log: draft,
      provider: providerInfo,
    };
  }

  // --- streaming (SSE passthrough) -------------------------------------------
  // Residual risk (accepted by C9): a *successful* (2xx) upstream body is piped
  // through byte-for-byte, so an upstream that echoes its own credential inside a
  // successful SSE payload would still reach the client. Scrubbing success bodies
  // is impossible without buffering them, which C9 forbids. Error responses are
  // the practical reflection vector and are scrubbed below (and in the non-stream
  // branch above); response headers and the reason phrase are scrubbed as well.
  const nullBody = hasNullBodyStatus(upstream.status);
  const draft: RelayLogDraft = {
    protocol,
    path,
    model: bodyModel,
    upstream: provider.name,
    status: upstream.status,
    latencyMs: 0,
    inputTokens: null,
    outputTokens: null,
    apiKeyId,
    // A null-body status (204/205/304) is a *normal* upstream answer — the client
    // receives that very status — so it is not logged as an error. Everything else
    // outside 2xx is.
    error: upstream.ok || nullBody ? null : `upstream responded ${upstream.status}`,
    stream: true,
  };

  const upstreamBody = upstream.body;

  if (nullBody) {
    // The client asked for SSE, but the upstream answered with a status that cannot
    // carry a body: there is no event stream to pipe, and the `Response`
    // constructor rejects one for 204/205/304. Answer with the upstream status and
    // no body, and record that same status (error stays null: nothing failed).
    await cancelUpstreamBody(upstreamBody);
    draft.latencyMs = Date.now() - startedAt;
    persistLog(draft);
    return {
      response: relayResponse(upstream.status, statusText, responseHeaders, null),
      log: draft,
      provider: providerInfo,
    };
  }

  // An upstream *error* response is not part of C9's chunk-by-chunk passthrough
  // guarantee: that guarantee exists so a successful SSE answer streams without
  // buffering. Error payloads are small, and an upstream (self-hosted gateways in
  // particular) may echo the x-api-key / Authorization value it received inside
  // them. Replying with those bytes verbatim would hand the operator's upstream
  // credential to the lowest-privilege party — the `ar-...` client — who could
  // then consume the upstream's quota directly, past this gateway's limits and
  // revocation. So: buffer the bounded error body, scrub it, then answer with the
  // redacted text (still `text/event-stream` when the payload is SSE shaped).
  if (upstream.status >= 400) {
    let raw = '';
    let complete = true;
    if (upstreamBody) {
      const buffered = await bufferErrorBody(upstreamBody, redactError);
      raw = buffered.text;
      complete = buffered.complete;
    }

    draft.latencyMs = Date.now() - startedAt;
    draft.error = redactPreview(raw, [upstreamApiKey], ERROR_PREVIEW_LIMIT, `upstream responded ${upstream.status}`);

    if (!complete || raw.trim().length === 0) {
      // Never forward a partially read error body (a cut could split the credential
      // so it no longer matches the redaction), and never answer an error status
      // with an empty body: both cases get a synthetic, credential-free structured
      // error so a client SDK always has `{type,error:{type,message}}` to report.
      persistLog(draft);
      return {
        response: clientError(`upstream responded ${upstream.status}`, upstream.status, 'api_error'),
        log: draft,
        provider: providerInfo,
      };
    }

    persistLog(draft);
    return {
      // The bounded error body is forwarded only after the credential is scrubbed
      // out of it; the content type stays whatever the upstream sent (JSON stays
      // JSON, SSE stays SSE).
      response: relayResponse(
        upstream.status,
        statusText,
        responseHeaders,
        new TextEncoder().encode(redactSecrets(raw, [upstreamApiKey])),
      ),
      log: draft,
      provider: providerInfo,
    };
  }

  if (!upstreamBody) {
    draft.latencyMs = Date.now() - startedAt;
    persistLog(draft);
    return {
      // No body from the upstream: answer with an explicitly empty one.
      response: relayResponse(upstream.status, statusText, responseHeaders, null),
      log: draft,
      provider: providerInfo,
    };
  }

  const decoder = new TextDecoder();
  const usage: UsageSnapshot = { inputTokens: 0, outputTokens: 0, model: bodyModel };
  let pending = '';
  let finalized = false;

  /**
   * Persist the log row exactly once, either when the stream ends (`flush`) or
   * when the client disconnects (`cancel`).
   */
  const finalize = (disconnectMessage?: string): void => {
    if (finalized) return;
    finalized = true;
    draft.latencyMs = Date.now() - startedAt;
    draft.model = usage.model ?? bodyModel;
    draft.inputTokens = usage.inputTokens > 0 ? usage.inputTokens : null;
    draft.outputTokens = usage.outputTokens > 0 ? usage.outputTokens : null;
    if (disconnectMessage) draft.error = disconnectMessage;
    persistLog(draft);
  };

  const reader = upstreamBody.getReader();

  // Source leg: hand over upstream chunks one at a time (never the whole body),
  // so a slow client applies backpressure instead of buffering in memory.
  const source = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          controller.close();
          return;
        }
        if (value) controller.enqueue(value);
      } catch (error) {
        finalize('upstream stream failed');
        controller.error(error);
      }
    },
    cancel(reason) {
      finalize('client disconnected before the stream completed');
      reader.cancel(reason).catch(() => undefined);
    },
  });

  // Transform leg: byte-exact passthrough plus SSE usage accumulation.
  const transformer = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      // Byte-exact passthrough first: the client never waits for buffering.
      controller.enqueue(chunk);
      try {
        const text = decoder.decode(chunk, { stream: true });
        pending += text;
        if (pending.length > MAX_SSE_BUFFER) {
          // Defensive: an upstream that never emits newlines must not grow unbounded.
          pending = pending.slice(-MAX_SSE_BUFFER);
        }
        let newlineIndex = pending.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = pending.slice(0, newlineIndex).replace(/\r$/, '');
          pending = pending.slice(newlineIndex + 1);
          if (line.startsWith('data:')) {
            applySseData(protocol, line.slice(5).trim(), usage);
          }
          newlineIndex = pending.indexOf('\n');
        }
      } catch (error) {
        console.error('[relay] unable to parse SSE chunk:', error);
      }
    },
    flush() {
      try {
        const tail = pending.trim();
        if (tail.startsWith('data:')) applySseData(protocol, tail.slice(5).trim(), usage);
      } catch {
        // ignore malformed trailing data
      }
      finalize();
    },
  });

  return {
    // SSE keeps streaming byte-for-byte; `relayResponse` only guarantees the
    // status is legal for the body it is given.
    response: relayResponse(upstream.status, statusText, responseHeaders, source.pipeThrough(transformer)),
    log: draft,
    provider: providerInfo,
  };
}
