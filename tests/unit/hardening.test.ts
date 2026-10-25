import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import * as keysRoute from '@/app/api/admin/keys/route';
import { parseJsonBody } from '@/lib/api-helpers';
import { createApiKey } from '@/lib/apikeys';
import {
  DEFAULT_MAX_BUFFERED_RESPONSE_BYTES,
  DEFAULT_MAX_REQUEST_BODY_BYTES,
  getMaxBufferedResponseBytes,
  getMaxRequestBodyBytes,
} from '@/lib/env';
import { request } from 'node:http';
import { listRequestLogs } from '@/lib/logs';
import { createProvider } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import { adminHeaders, jsonRequest, prepareTestEnv, readJson } from './test-helpers';

/**
 * Resource-exhaustion hardening (offline: `fetch` is stubbed, `DATABASE_PATH`
 * is `:memory:`).
 *
 * Both the inbound body reader and the non-streaming upstream buffer used to be
 * unbounded, so a single `ar-...` key holder (the lowest-privilege party) or a
 * hostile upstream could exhaust the server's memory. Each bound below is
 * verified to (a) reject/stream instead of buffering, and (b) keep the documented
 * response envelope (C2 for clients, C4 for the console).
 */

const BASE = 'http://localhost';
const UPSTREAM_KEY = 'sk-ant-hardening-probe-secret-0123456789';

/** A stream that yields `chunkSize` bytes per pull, forever, and records reads. */
function endlessStream(chunkSize: number) {
  const stats = { reads: 0, cancelled: false };
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      stats.reads += 1;
      controller.enqueue(new Uint8Array(chunkSize).fill(0x61));
    },
    cancel() {
      stats.cancelled = true;
    },
  });
  return { stream, stats };
}

beforeEach(() => {
  prepareTestEnv();
  delete process.env.MAX_REQUEST_BODY_BYTES;
  delete process.env.MAX_BUFFERED_RESPONSE_BYTES;
});

afterEach(() => {
  delete process.env.MAX_REQUEST_BODY_BYTES;
  delete process.env.MAX_BUFFERED_RESPONSE_BYTES;
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('inbound request bodies are read with a byte budget', () => {
  it('exposes a sane default budget and honours the env override', () => {
    expect(getMaxRequestBodyBytes()).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
    expect(DEFAULT_MAX_REQUEST_BODY_BYTES).toBeGreaterThanOrEqual(1024 * 1024);
    process.env.MAX_REQUEST_BODY_BYTES = '4096';
    expect(getMaxRequestBodyBytes()).toBe(4096);
    process.env.MAX_REQUEST_BODY_BYTES = 'not-a-number';
    expect(getMaxRequestBodyBytes()).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
    process.env.MAX_REQUEST_BODY_BYTES = '-5';
    expect(getMaxRequestBodyBytes()).toBe(DEFAULT_MAX_REQUEST_BODY_BYTES);
  });

  it('answers 413 and stops reading once the budget is exceeded', async () => {
    const { stream, stats } = endlessStream(1024);
    const parsed = await parseJsonBody(
      new Request(`${BASE}/api/v1/messages`, { method: 'POST', body: stream, duplex: 'half' } as RequestInit),
      4 * 1024,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.status).toBe(413);
    expect(parsed.message).toContain('too large');
    // The reader must stop early instead of draining the whole (endless) body.
    expect(stats.reads).toBeLessThanOrEqual(8);
    expect(stats.cancelled).toBe(true);
  });

  it('rejects an over-budget declared content-length without reading the body', async () => {
    let pulled = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(16));
      },
    });
    const parsed = await parseJsonBody(
      new Request(`${BASE}/api/v1/messages`, {
        method: 'POST',
        headers: { 'content-length': '9000000' },
        body: stream,
        duplex: 'half',
      } as RequestInit),
      1024,
    );
    expect(parsed.ok).toBe(false);
    if (parsed.ok) throw new Error('unreachable');
    expect(parsed.status).toBe(413);
    // Nothing was pulled by the parser itself (the Request wrapper may have
    // prefetched one chunk; the point is that the budget check short-circuits).
    expect(pulled).toBeLessThanOrEqual(1);
  });

  it('keeps the normal error envelopes for empty, malformed and non-object bodies', async () => {
    const empty = await parseJsonBody(new Request(`${BASE}/x`, { method: 'POST' }));
    expect(empty).toEqual({ ok: false, message: 'request body is required', status: 400 });

    const malformed = await parseJsonBody(new Request(`${BASE}/x`, { method: 'POST', body: '{oops' }));
    expect(malformed.ok).toBe(false);
    if (malformed.ok) throw new Error('unreachable');
    expect(malformed.status).toBe(400);
    expect(malformed.message).toContain('valid JSON');

    const array = await parseJsonBody(new Request(`${BASE}/x`, { method: 'POST', body: '[1,2]' }));
    expect(array.ok).toBe(false);
    if (array.ok) throw new Error('unreachable');
    expect(array.message).toContain('JSON object');

    const good = await parseJsonBody(new Request(`${BASE}/x`, { method: 'POST', body: '{"model":"m"}' }));
    expect(good.ok).toBe(true);
    if (!good.ok) throw new Error('unreachable');
    expect(good.body.model).toBe('m');
  });

  it('client routes answer 413 with a structured Anthropic-style error', async () => {
    process.env.MAX_REQUEST_BODY_BYTES = '64';
    const created = createApiKey('oversize client key', 'key_oversize_client');
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const big = JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'x'.repeat(200) }] });
    const routes: Array<[typeof messagesRoute, string]> = [
      [messagesRoute, '/api/v1/messages'],
      [chatRoute, '/api/v1/chat/completions'],
    ];
    for (const [route, path] of routes) {
      const response = await route.POST(
        jsonRequest(`${BASE}${path}`, { body: big, headers: { 'x-api-key': created.key } }),
      );
      expect(response.status).toBe(413);
      const body = await readJson<{ type: string; error: { type: string; message: string } }>(response);
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('request_too_large');
      expect(body.error.message).toContain('too large');
    }
    // An oversized body never reaches the upstream (or the log).
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('admin routes answer 413 with the C4 error envelope', async () => {
    process.env.MAX_REQUEST_BODY_BYTES = '32';
    const response = await keysRoute.POST(
      jsonRequest(`${BASE}/api/admin/keys`, {
        body: { name: 'x'.repeat(400) },
        headers: adminHeaders(),
      }),
    );
    expect(response.status).toBe(413);
    const body = await readJson<{ error: { message: string } }>(response);
    expect(typeof body.error.message).toBe('string');
    expect(body.error.message).toContain('too large');
  });
});

describe('non-streaming upstream responses are buffered with a byte budget', () => {
  it('exposes a sane default buffer budget and honours the env override', () => {
    expect(getMaxBufferedResponseBytes()).toBe(DEFAULT_MAX_BUFFERED_RESPONSE_BYTES);
    process.env.MAX_BUFFERED_RESPONSE_BYTES = '2048';
    expect(getMaxBufferedResponseBytes()).toBe(2048);
    process.env.MAX_BUFFERED_RESPONSE_BYTES = '0';
    expect(getMaxBufferedResponseBytes()).toBe(DEFAULT_MAX_BUFFERED_RESPONSE_BYTES);
  });

  it('extracts usage for a body inside the budget (unchanged behaviour)', async () => {
    createProvider({
      name: 'anthropic-budget',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: UPSTREAM_KEY,
    });
    process.env.MAX_BUFFERED_RESPONSE_BYTES = '65536';
    const payload = JSON.stringify({ id: 'msg_1', model: 'claude-3', usage: { input_tokens: 3, output_tokens: 4 } });
    const fetchMock = vi.fn<typeof fetch>(
      async () => new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, { method: 'POST', body: '{}' }),
      body: { model: 'claude-3' },
    });
    expect(await result.response.text()).toBe(payload);
    expect(result.log.inputTokens).toBe(3);
    expect(result.log.outputTokens).toBe(4);
    expect(result.log.model).toBe('claude-3');
  });

  it('streams an over-budget body through without losing bytes and logs it', async () => {
    createProvider({
      name: 'anthropic-oversize',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: UPSTREAM_KEY,
    });
    process.env.MAX_BUFFERED_RESPONSE_BYTES = '1024';

    const chunks = ['{"id":"msg_big","model":"claude-3","text":"', 'x'.repeat(4096), '"}'];
    const encoder = new TextEncoder();
    const fetchMock = vi.fn<typeof fetch>(async () => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
          controller.close();
        },
      });
      return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);

    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, { method: 'POST', body: '{}' }),
      body: { model: 'claude-3' },
      apiKeyId: 'key_oversize',
    });

    const expected = chunks.join('');
    expect(await result.response.text()).toBe(expected);
    expect(result.response.status).toBe(200);
    // Token counts cannot be extracted without buffering; the row is still written.
    expect(result.log.inputTokens).toBeNull();
    expect(result.log.outputTokens).toBeNull();
    const rows = listRequestLogs({ limit: 10 });
    expect(rows.data).toHaveLength(1);
    expect(rows.data[0]?.status).toBe(200);
    expect(rows.data[0]?.stream).toBe(false);
    expect(rows.data[0]?.model).toBe('claude-3');
  });

  it('never buffers more than the budget from an endless upstream body', async () => {
    createProvider({
      name: 'anthropic-endless',
      protocol: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      apiKey: UPSTREAM_KEY,
    });
    process.env.MAX_BUFFERED_RESPONSE_BYTES = '4096';

    const { stream, stats } = endlessStream(1024);
    vi.stubGlobal('fetch', vi.fn<typeof fetch>(async () => new Response(stream, { status: 200 })));

    const result = await relay({
      protocol: 'anthropic',
      request: new Request(`${BASE}/api/v1/messages`, { method: 'POST', body: '{}' }),
      body: { model: 'claude-3' },
    });
    // Read a bounded amount, then walk away (a real client would keep reading).
    const reader = result.response.body!.getReader();
    let received = 0;
    for (let i = 0; i < 8; i += 1) {
      const { value } = await reader.read();
      received += value?.byteLength ?? 0;
    }
    await reader.cancel();
    expect(received).toBeGreaterThan(0);
    // The relay stopped reading at the budget instead of draining the stream.
    expect(stats.reads).toBeLessThanOrEqual(64);
  });
});
