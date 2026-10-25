import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as logsRoute from '@/app/api/admin/logs/route';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import { createApiKey } from '@/lib/apikeys';
import { queryAll, queryOne } from '@/lib/db';
import { createProvider, getRelayProvider, testProviderConnection } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import { REDACTED_PLACEHOLDER, redactPreview, redactSecrets } from '@/lib/upstream';
import { adminHeaders, jsonRequest, prepareTestEnv, readJson } from './test-helpers';

/**
 * Regression suite for the credential-reflection defect:
 *
 * An upstream (typically a self-hosted gateway) may echo the `x-api-key` /
 * `Authorization` value it received inside an error body. Before the fix that
 * text was copied into `request_logs.error` (served by `GET /api/admin/logs`)
 * and into the `/api/admin/providers/[id]/test` message, so a plaintext upstream
 * key could reach the console. Acceptance: "任何管理端响应都不含上游明文 key".
 *
 * Every case here is offline (fetch is stubbed) and uses DATABASE_PATH=:memory:.
 */

const BASE = 'http://localhost';
const REFLECTED_KEY = 'sk-ant-reflected-secret-value-42';

interface LogRow {
  status: number;
  error: string | null;
  stream: number;
}

function logRows(): LogRow[] {
  return queryAll<LogRow>('SELECT status, error, stream FROM request_logs');
}

function anthropicProvider(apiKey = REFLECTED_KEY) {
  return createProvider({
    name: 'anthropic-reflect',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey,
  });
}

function openaiProvider(apiKey = REFLECTED_KEY) {
  return createProvider({
    name: 'openai-reflect',
    protocol: 'openai',
    baseUrl: 'https://api.openai.com',
    apiKey,
  });
}

function relayRequest(bodyPath = '/api/v1/messages'): Request {
  return new Request(`${BASE}${bodyPath}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('redactSecrets', () => {
  it('replaces every occurrence of a known credential, in any letter case', () => {
    const secret = 'sk-ant-known-secret';
    const text = `first ${secret} then SK-ANT-KNOWN-SECRET again`;
    const out = redactSecrets(text, [secret]);
    expect(out).toBe(`first ${REDACTED_PLACEHOLDER} then ${REDACTED_PLACEHOLDER} again`);
    expect(out.toLowerCase()).not.toContain(secret);
  });

  it('also scrubs the percent-encoded rendering used in URLs', () => {
    const secret = 'sk-ant/secret+value=1';
    const encoded = encodeURIComponent(secret);
    expect(encoded).not.toBe(secret);
    const out = redactSecrets(`GET /v1/models?key=${encoded} -> 401`, [secret]);
    expect(out).toBe(`GET /v1/models?key=${REDACTED_PLACEHOLDER} -> 401`);
  });

  it('also scrubs the JSON-escaped rendering used inside an upstream error body', () => {
    const secret = 'sk-ant"quoted"\\slash-key-9';
    const body = JSON.stringify({ type: 'error', error: { message: `bad key ${secret}` } });
    expect(body).not.toContain(secret); // the raw form is escaped inside JSON
    const out = redactSecrets(body, [secret]);
    expect(out).not.toContain('quoted');
    expect(out).not.toContain('slash-key');
    expect(out).toContain(REDACTED_PLACEHOLDER);
    expect(out).toContain('bad key');
  });

  it('redacts bearer tokens even when the secret is unknown', () => {
    expect(redactSecrets('upstream said: Bearer sk-live-abc123def456 rejected', [])).toBe(
      `upstream said: Bearer ${REDACTED_PLACEHOLDER} rejected`,
    );
    // Prose must survive: a plain word after "bearer" is not a token.
    expect(redactSecrets('bearer authentication is required', [])).toBe('bearer authentication is required');
  });

  it('only replaces a very short secret when it stands alone as a token', () => {
    expect(redactSecrets('cab ab abc', ['ab'])).toBe(`cab ${REDACTED_PLACEHOLDER} abc`);
  });

  it('ignores empty, non-string and unmatched secrets', () => {
    const text = 'no secrets here';
    expect(redactSecrets(text, [])).toBe(text);
    expect(redactSecrets(text, ['', '   ', null, undefined])).toBe(text);
    expect(redactSecrets(text, ['sk-ant-unrelated'])).toBe(text);
    expect(redactSecrets('', ['sk-ant-known-secret'])).toBe('');
  });
});

describe('redactPreview', () => {
  it('redacts before truncating so a cut cannot expose a key prefix', () => {
    const secret = 'sk-ant-straddle-me-0001';
    const text = `${'x'.repeat(795)}${secret}`;
    const preview = redactPreview(text, [secret], 800, 'fallback');
    expect(preview.startsWith('xxx')).toBe(true);
    expect(preview).not.toContain('sk-ant');
    expect(preview).not.toContain(secret.slice(0, 8));
  });

  it('flattens whitespace and falls back when nothing is left', () => {
    const secret = 'sk-ant-known-secret';
    expect(redactPreview(`a\n\n b\tc ${secret}`, [secret], 200)).toBe(`a b c ${REDACTED_PLACEHOLDER}`);
    expect(redactPreview('   \n ', [secret], 200, 'fallback')).toBe('fallback');
    expect(redactPreview('short', [secret], 3)).toBe('sho');
  });
});

describe('relay: upstream error text never carries the credential', () => {
  it('scrubs the reflected x-api-key out of a non-stream anthropic error row', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(
            JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: `bad key ${REFLECTED_KEY}` } }),
            { status: 401, headers: { 'content-type': 'application/json' } },
          ),
      ),
    );

    const result = await relay({ protocol: 'anthropic', request: relayRequest(), body: { model: 'claude-3' } });
    const clientBody = await result.response.text();

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe(401);
    expect(rows[0]?.stream).toBe(0);
    expect(rows[0]?.error).toBeTruthy();
    expect(rows[0]?.error).not.toContain(REFLECTED_KEY);
    expect(rows[0]?.error).not.toContain('sk-ant');
    expect(rows[0]?.error).toContain(REDACTED_PLACEHOLDER);
    expect(result.log.error).not.toContain(REFLECTED_KEY);

    // C9's byte-exact passthrough covers successful calls only. An *error* body is
    // scrubbed before it reaches the client too: the `ar-...` holder is the
    // lowest-privilege party and must never receive the operator's upstream key.
    expect(clientBody).not.toContain(REFLECTED_KEY);
    expect(clientBody).not.toContain('sk-ant');
    expect(clientBody).toContain(REDACTED_PLACEHOLDER);

    // Still a usable, parseable upstream error shape for the client SDK.
    const parsed = JSON.parse(clientBody) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.message).toBe(`bad key ${REDACTED_PLACEHOLDER}`);
  });

  it('scrubs the reflected Bearer token of an openai provider', async () => {
    openaiProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response('Incorrect API key provided: Bearer sk-ant-reflected-secret-value-42.', {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );

    const result = await relay({
      protocol: 'openai',
      request: relayRequest('/api/v1/chat/completions'),
      body: { model: 'gpt-4o' },
    });
    await result.response.text();

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.error).not.toContain(REFLECTED_KEY);
    expect(rows[0]?.error).not.toContain('sk-ant');
    expect(rows[0]?.error).toContain('Incorrect API key provided');
  });

  it('scrubs the reflected credential out of a streaming error row', async () => {
    anthropicProvider();
    const encoder = new TextEncoder();
    const payload = `data: {"type":"error","error":{"type":"authentication_error","message":"invalid x-api-key ${REFLECTED_KEY}"}}\n\n`;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(payload.slice(0, 40)));
            controller.enqueue(encoder.encode(payload.slice(40)));
            controller.close();
          },
        });
        return new Response(body, { status: 401, headers: { 'content-type': 'text/event-stream' } });
      }),
    );

    const result = await relay({
      protocol: 'anthropic',
      request: relayRequest(),
      body: { model: 'claude-3', stream: true },
    });
    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    // The error payload is still SSE shaped, but the reflected credential is gone:
    // a streaming *error* is not covered by C9's chunk-by-chunk passthrough.
    const clientStream = await result.response.text();
    expect(clientStream).not.toContain(REFLECTED_KEY);
    expect(clientStream).not.toContain('sk-ant');
    expect(clientStream.startsWith('data: ')).toBe(true);
    expect(clientStream.endsWith('\n\n')).toBe(true);
    const dataLine = clientStream.slice('data: '.length).trim();
    const parsed = JSON.parse(dataLine) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('authentication_error');
    expect(parsed.error.message).toBe(`invalid x-api-key ${REDACTED_PLACEHOLDER}`);

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stream).toBe(1);
    expect(rows[0]?.status).toBe(401);
    expect(rows[0]?.error).not.toContain(REFLECTED_KEY);
    expect(rows[0]?.error).toContain(REDACTED_PLACEHOLDER);
  });

  it('scrubs the credential from a transport error message', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new Error(`socket closed while sending x-api-key: ${REFLECTED_KEY}`);
      }),
    );

    const result = await relay({ protocol: 'anthropic', request: relayRequest(), body: { model: 'claude-3' } });
    await result.response.text();

    const rows = logRows();
    expect(rows[0]?.status).toBe(502);
    expect(rows[0]?.error).not.toContain(REFLECTED_KEY);
  });
});

describe('provider test message never carries the credential', () => {
  it('scrubs a reflected key while keeping the status detail usable', async () => {
    anthropicProvider();
    const provider = getRelayProvider(
      queryOne<{ id: string }>('SELECT id FROM providers LIMIT 1')?.id as string,
    );
    expect(provider).not.toBeNull();

    const result = await testProviderConnection(provider!, async () =>
      new Response(`{"error":{"message":"invalid x-api-key: ${REFLECTED_KEY}"}}`, {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(result.message).not.toContain(REFLECTED_KEY);
    expect(result.message).toContain(REDACTED_PLACEHOLDER);
  });

  it('scrubs a credential that appears in a thrown fetch error', async () => {
    anthropicProvider();
    const provider = getRelayProvider(
      queryOne<{ id: string }>('SELECT id FROM providers LIMIT 1')?.id as string,
    );

    const result = await testProviderConnection(provider!, async () => {
      throw new TypeError(`request to https://api.anthropic.com/v1/models failed: key ${REFLECTED_KEY}`);
    });

    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(REFLECTED_KEY);
  });

  it('scrubs a credential echoed in the upstream status text', async () => {
    anthropicProvider();
    const provider = getRelayProvider(
      queryOne<{ id: string }>('SELECT id FROM providers LIMIT 1')?.id as string,
    );

    const result = await testProviderConnection(
      provider!,
      async () => new Response('', { status: 403, statusText: `denied for ${REFLECTED_KEY}` }),
    );

    expect(result.ok).toBe(false);
    expect(result.message).toContain('403');
    expect(result.message).not.toContain(REFLECTED_KEY);
  });
});

describe('client-side error bodies never carry the upstream credential', () => {
  it('keeps a successful (200) body byte-exact while still scrubbing error bodies', async () => {
    anthropicProvider();
    // A success payload legitimately echoing the key (e.g. an echo endpoint) must
    // not be rewritten: C9's byte-exact passthrough applies to successful calls.
    const successPayload = JSON.stringify({ type: 'message', echo: REFLECTED_KEY, usage: { input_tokens: 1 } });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(successPayload, { status: 200 })),
    );

    const ok = await relay({ protocol: 'anthropic', request: relayRequest(), body: { model: 'claude-3' } });
    expect(ok.response.status).toBe(200);
    expect(await ok.response.text()).toBe(successPayload);
  });

  it('answers the openai entry point with a scrubbed error body', async () => {
    const created = createApiKey('reflect-openai-client', 'key-reflect-openai');
    openaiProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(`Incorrect API key provided: Bearer ${REFLECTED_KEY}.`, {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );

    const response = await chatRoute.POST(
      jsonRequest(`${BASE}/api/v1/chat/completions`, {
        body: { model: 'gpt-4o', messages: [] },
        headers: { authorization: `Bearer ${created.key}` },
      }),
    );
    expect(response.status).toBe(401);
    const clientBody = await response.text();
    expect(clientBody).not.toContain(REFLECTED_KEY);
    expect(clientBody).toContain('Incorrect API key provided');
  });

  it('scrubs a credential echoed in a forwarded response header or reason phrase', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response('nope', {
            status: 403,
            statusText: `denied for ${REFLECTED_KEY}`,
            headers: { 'x-upstream-hint': `key=${REFLECTED_KEY}` },
          }),
      ),
    );

    const result = await relay({ protocol: 'anthropic', request: relayRequest(), body: { model: 'claude-3' } });
    expect(result.response.status).toBe(403);
    expect(result.response.headers.get('x-upstream-hint')).not.toContain(REFLECTED_KEY);
    expect(result.response.statusText).not.toContain(REFLECTED_KEY);
    expect(await result.response.text()).not.toContain(REFLECTED_KEY);
  });

  it('replaces an oversized error body instead of forwarding a cut copy', async () => {
    anthropicProvider();
    const huge = `${'x'.repeat(300 * 1024)}${REFLECTED_KEY}`;
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(huge, { status: 500, headers: { 'content-type': 'text/plain' } })),
    );

    const result = await relay({ protocol: 'anthropic', request: relayRequest(), body: { model: 'claude-3' } });
    expect(result.response.status).toBe(500);
    const clientBody = await result.response.text();
    expect(clientBody.length).toBeLessThan(4096);
    expect(clientBody).not.toContain(REFLECTED_KEY);
    expect(JSON.parse(clientBody)).toMatchObject({ type: 'error', error: { message: expect.stringContaining('500') } });
  });

  it('never forwards an upstream error body it could not read to completion', async () => {
    anthropicProvider();
    const encoder = new TextEncoder();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        const body = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode(`partial x-api-key ${REFLECTED_KEY.slice(0, 12)}`));
            controller.error(new Error('upstream reset'));
          },
        });
        return new Response(body, { status: 500, headers: { 'content-type': 'text/plain' } });
      }),
    );

    const result = await relay({
      protocol: 'anthropic',
      request: relayRequest(),
      body: { model: 'claude-3', stream: true },
    });
    expect(result.response.status).toBe(500);
    const clientBody = await result.response.text();
    expect(clientBody).not.toContain('sk-ant');
    const parsed = JSON.parse(clientBody) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.message).toContain('500');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.stream).toBe(1);
    expect(rows[0]?.error ?? '').not.toContain(REFLECTED_KEY);
  });
});

describe('admin API surface sweep', () => {
  it('keeps the upstream key out of /api/admin/logs and out of the stored row', async () => {
    createApiKey('reflect-client', 'key-reflect');
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(`upstream rejected x-api-key ${REFLECTED_KEY}`, {
            status: 401,
            headers: { 'content-type': 'text/plain' },
          }),
      ),
    );

    const clientResponse = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { 'x-api-key': 'ar-invalid-but-that-is-not-the-point' },
      }),
    );
    // The client key is invalid, so nothing was relayed yet: create a real one.
    expect(clientResponse.status).toBe(401);

    const created = createApiKey('reflect-client-2', 'key-reflect-2');
    const relayed = await messagesRoute.POST(
      jsonRequest(`${BASE}/api/v1/messages`, {
        body: { model: 'claude-3', messages: [] },
        headers: { 'x-api-key': created.key },
      }),
    );
    expect(relayed.status).toBe(401);
    await relayed.text();

    const stored = queryAll<LogRow>('SELECT status, error, stream FROM request_logs');
    expect(stored.length).toBeGreaterThan(0);
    for (const row of stored) expect(row.error ?? '').not.toContain(REFLECTED_KEY);

    const logsResponse = await logsRoute.GET(
      jsonRequest(`${BASE}/api/admin/logs?limit=50`, { method: 'GET', headers: adminHeaders() }),
    );
    expect(logsResponse.status).toBe(200);
    const page = await readJson<{ data: Array<{ error: string | null }> }>(logsResponse);
    expect(page.data.length).toBeGreaterThan(0);
    expect(JSON.stringify(page)).not.toContain(REFLECTED_KEY);
    for (const entry of page.data) expect(entry.error ?? '').not.toContain(REFLECTED_KEY);
  });
});
