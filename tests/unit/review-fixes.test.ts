import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as chatRoute from '@/app/api/v1/chat/completions/route';
import * as messagesRoute from '@/app/api/v1/messages/route';
import { createProvider } from '@/lib/providers';
import { relay } from '@/lib/proxy';
import { buildUpstreamHeaders } from '@/lib/upstream';
import { jsonRequest, prepareTestEnv } from './test-helpers';

/**
 * Review-round regression tests (rev1) for two error-path defects found while
 * reviewing the credential-redaction rework. Offline: `fetch` is stubbed and
 * `DATABASE_PATH` is `:memory:`.
 *
 * 1. C9 forwarding fidelity: the relay resolves `stream` from the JSON body
 *    first (`wantsStream`), but `buildUpstreamHeaders` used to look at the
 *    inbound `Accept` header only. A client sending `{"stream": true}` with no
 *    `Accept` header (the common SDK shape) was therefore served as SSE while
 *    the upstream was asked for JSON.
 * 2. Structured error contract: an upstream error status with an empty body was
 *    forwarded as a bare status with an empty body, leaving client SDKs nothing
 *    to report. Every client-facing error path must carry
 *    `{type:'error',error:{type,message}}` (C2).
 */

const BASE = 'http://localhost';
const UPSTREAM_KEY = 'sk-ant-review-probe-secret-0123456789';

function sseHost(chunks: string[], status = 200, headers: Record<string, string> = {}) {
  const encoder = new TextEncoder();
  return vi.fn<typeof fetch>(async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return new Response(body, { status, headers: { 'content-type': 'text/event-stream', ...headers } });
  });
}

function relayOnce(body: Record<string, unknown>, init: { accept?: string } = {}) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (init.accept) headers.accept = init.accept;
  return relay({
    protocol: 'anthropic',
    request: new Request(`${BASE}/api/v1/messages`, { method: 'POST', headers, body: JSON.stringify(body) }),
    body,
  });
}

beforeEach(() => {
  prepareTestEnv();
  createProvider({
    name: 'anthropic-review',
    protocol: 'anthropic',
    baseUrl: 'https://api.anthropic.com',
    apiKey: UPSTREAM_KEY,
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('C9: the resolved stream decision is what the upstream is told', () => {
  it('sends accept: text/event-stream when only body.stream=true was sent', async () => {
    const fetchMock = sseHost(['data: {"type":"message_start"}\n\n']);
    vi.stubGlobal('fetch', fetchMock);

    const result = await relayOnce({ model: 'claude-3', stream: true });
    const sentHeaders = fetchMock.mock.calls[0]?.[1]?.headers as Headers;
    expect(sentHeaders.get('accept')).toBe('text/event-stream');
    await result.response.text();
  });

  it('keeps accept: application/json for a non-stream call, even behind an SSE Accept header', () => {
    expect(buildUpstreamHeaders('anthropic', UPSTREAM_KEY, new Headers()).get('accept')).toBe('application/json');
    expect(
      buildUpstreamHeaders('anthropic', UPSTREAM_KEY, new Headers({ accept: 'application/json' }), false).get('accept'),
    ).toBe('application/json');
    // An explicit body.stream:false wins over the inbound header (wantsStream), so the
    // upstream must be asked for JSON as well.
    expect(
      buildUpstreamHeaders('anthropic', UPSTREAM_KEY, new Headers({ accept: 'text/event-stream' }), false).get(
        'accept',
      ),
    ).toBe('application/json');
    expect(
      buildUpstreamHeaders('anthropic', UPSTREAM_KEY, new Headers(), true).get('accept'),
    ).toBe('text/event-stream');
  });

  it('answers a stream:true call with text/event-stream even when a 2xx upstream mislabels its body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () => new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const result = await relayOnce({ model: 'claude-3', stream: true });
    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    await result.response.text();
  });

  it('does not relabel an error body as event-stream (a JSON error must stay JSON)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () => new Response('{"error":"nope"}', { status: 429, headers: { 'content-type': 'application/json' } }),
      ),
    );
    const result = await relayOnce({ model: 'claude-3', stream: true });
    expect(result.response.status).toBe(429);
    expect(result.response.headers.get('content-type')).toContain('application/json');
    expect(await result.response.text()).toBe('{"error":"nope"}');
  });
});

describe('C2: an empty upstream error body still yields a structured, actionable error', () => {
  it('answers a body-less upstream error with {type:error,error:{type,message}} (non-stream)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(null, { status: 502, statusText: 'Bad Gateway' })),
    );
    const result = await relayOnce({ model: 'claude-3' });
    expect(result.response.status).toBe(502);
    const parsed = (await result.response.json()) as { type: string; error: { type: string; message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.type).toBe('api_error');
    expect(parsed.error.message).toContain('502');
    expect(JSON.stringify(parsed)).not.toContain(UPSTREAM_KEY);
  });

  it('does the same on the streaming path', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => new Response(null, { status: 500, statusText: 'Server Error' })),
    );
    const result = await relayOnce({ model: 'claude-3', stream: true });
    expect(result.response.status).toBe(500);
    const parsed = (await result.response.json()) as { type: string; error: { message: string } };
    expect(parsed.type).toBe('error');
    expect(parsed.error.message).toContain('500');
  });
});

describe('acceptance spot-checks through the real routes', () => {
  it('answers 401 authentication_error for a missing or bad key on both client entries', async () => {
    const fetchSpy = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const headerSets: Array<Record<string, string>> = [
      {},
      { 'x-api-key': 'ar-unknown' },
      { authorization: 'Bearer ar-unknown' },
    ];
    const routes: Array<[typeof messagesRoute, string]> = [
      [messagesRoute, '/api/v1/messages'],
      [chatRoute, '/api/v1/chat/completions'],
    ];
    for (const [route, path] of routes) {
      for (const headers of headerSets) {
        const response = await route.POST(jsonRequest(`${BASE}${path}`, { body: { model: 'm' }, headers }));
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({
          type: 'error',
          error: { type: 'authentication_error', message: 'invalid x-api-key' },
        });
      }
    }
    // A rejected key never reaches the upstream.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
