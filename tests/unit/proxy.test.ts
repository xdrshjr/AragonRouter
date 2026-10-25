import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryAll } from '@/lib/db';
import {
  applySseData,
  parseUsageFromJson,
  relay,
  type UsageSnapshot,
} from '@/lib/proxy';
import { createProvider } from '@/lib/providers';
import { joinUpstreamUrl, buildUpstreamHeaders } from '@/lib/upstream';
import {
  UPSTREAM_ANTHROPIC_KEY,
  UPSTREAM_OPENAI_KEY,
  prepareTestEnv,
} from './test-helpers';

interface LogRow {
  protocol: string;
  path: string;
  model: string | null;
  upstream: string | null;
  status: number;
  latency_ms: number;
  input_tokens: number | null;
  output_tokens: number | null;
  api_key_id: string | null;
  error: string | null;
  stream: number;
}

function logRows(): LogRow[] {
  return queryAll<LogRow>('SELECT * FROM request_logs');
}

function anthropicProvider(baseUrl = 'https://api.anthropic.com/') {
  return createProvider({
    name: 'anthropic-main',
    protocol: 'anthropic',
    baseUrl,
    apiKey: UPSTREAM_ANTHROPIC_KEY,
  });
}

function openaiProvider(baseUrl = 'https://api.openai.com/v1') {
  return createProvider({
    name: 'openai-main',
    protocol: 'openai',
    baseUrl,
    apiKey: UPSTREAM_OPENAI_KEY,
  });
}

function clientRequest(path: string, body: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`http://localhost${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': 'ar-client', ...headers },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  prepareTestEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('relay: upstream URL and header handling (C9)', () => {
  it('joins base URLs without duplicating /v1', () => {
    expect(joinUpstreamUrl('https://api.anthropic.com', '/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(joinUpstreamUrl('https://api.anthropic.com/', '/v1/messages')).toBe(
      'https://api.anthropic.com/v1/messages',
    );
    expect(joinUpstreamUrl('https://gateway.example.com/v1', '/v1/chat/completions')).toBe(
      'https://gateway.example.com/v1/chat/completions',
    );
    expect(joinUpstreamUrl('http://127.0.0.1:4319/api/v1/', '/v1/models')).toBe(
      'http://127.0.0.1:4319/api/v1/models',
    );
    expect(joinUpstreamUrl('http://127.0.0.1:4319', '/v1/models')).toBe(
      'http://127.0.0.1:4319/v1/models',
    );
  });

  it('strips client credentials, hop-by-hop headers and cookies', () => {
    const inbound = new Headers({
      authorization: 'Bearer ar-client-key',
      'x-api-key': 'ar-client-key',
      cookie: 'aragon_session=abc',
      connection: 'keep-alive',
      'content-length': '42',
      'accept-encoding': 'gzip',
      'content-type': 'application/json',
      'anthropic-beta': 'prompt-caching-2024-07-31',
      'user-agent': 'test-client/1.0',
    });
    const headers = buildUpstreamHeaders('anthropic', UPSTREAM_ANTHROPIC_KEY, inbound);
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-api-key')).toBe(UPSTREAM_ANTHROPIC_KEY);
    expect(headers.get('anthropic-version')).toBe('2023-06-01');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('connection')).toBeNull();
    expect(headers.get('content-length')).toBeNull();
    expect(headers.get('accept-encoding')).toBeNull();
    expect(headers.get('anthropic-beta')).toBe('prompt-caching-2024-07-31');
    expect(headers.get('user-agent')).toBe('test-client/1.0');
  });

  it('uses Bearer auth for openai providers', () => {
    const headers = buildUpstreamHeaders('openai', UPSTREAM_OPENAI_KEY, new Headers());
    expect(headers.get('authorization')).toBe(`Bearer ${UPSTREAM_OPENAI_KEY}`);
    expect(headers.get('x-api-key')).toBeNull();
  });

  it('passes a custom inbound anthropic-version through', () => {
    const headers = buildUpstreamHeaders(
      'anthropic',
      'sk-x',
      new Headers({ 'anthropic-version': '2024-01-01' }),
    );
    expect(headers.get('anthropic-version')).toBe('2024-01-01');
  });
});

describe('relay: non-streaming', () => {
  it('forwards the upstream body byte-for-byte and logs usage (anthropic)', async () => {
    anthropicProvider();
    const payload = {
      id: 'msg_1',
      type: 'message',
      model: 'claude-3-5-sonnet',
      usage: { input_tokens: 7, output_tokens: 11 },
      content: [{ type: 'text', text: 'hello' }],
    };
    const serialized = JSON.stringify(payload);
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(serialized, {
        status: 200,
        headers: { 'content-type': 'application/json', 'request-id': 'req_1' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = { model: 'claude-3-5-sonnet', max_tokens: 16, messages: [{ role: 'user', content: 'hi' }] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
      apiKeyId: 'key-1',
    });

    expect(result.response.status).toBe(200);
    expect(result.response.headers.get('content-type')).toContain('application/json');
    expect(await result.response.text()).toBe(serialized);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const call = fetchMock.mock.calls[0];
    expect(call).toBeDefined();
    const [url, init] = call as [string, RequestInit];
    expect(url).toBe('https://api.anthropic.com/v1/messages');
    expect(init.method).toBe('POST');
    expect(JSON.parse(String(init.body))).toEqual(body);
    const headers = new Headers(init.headers);
    expect(headers.get('x-api-key')).toBe(UPSTREAM_ANTHROPIC_KEY);
    expect(headers.get('authorization')).toBeNull();

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3-5-sonnet',
      upstream: 'anthropic-main',
      status: 200,
      input_tokens: 7,
      output_tokens: 11,
      api_key_id: 'key-1',
      error: null,
      stream: 0,
    });
    expect(Number(rows[0]?.latency_ms)).toBeGreaterThanOrEqual(0);
  });

  it('forwards openai chat completions with Bearer auth and logs prompt/completion tokens', async () => {
    openaiProvider();
    const payload = {
      id: 'chatcmpl-1',
      model: 'gpt-4o-mini',
      usage: { prompt_tokens: 13, completion_tokens: 21, total_tokens: 34 },
      choices: [{ message: { role: 'assistant', content: 'yo' } }],
    };
    const fetchMock = vi.fn<typeof fetch>(async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const body = { model: 'gpt-4o-mini', messages: [{ role: 'user', content: 'hi' }] };
    const result = await relay({
      protocol: 'openai',
      request: clientRequest('/api/v1/chat/completions', body, {
        authorization: 'Bearer ar-client-key',
      }),
      body,
    });

    expect(result.response.status).toBe(200);
    const call = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(call[0]).toBe('https://api.openai.com/v1/chat/completions');
    const headers = new Headers(call[1].headers);
    expect(headers.get('authorization')).toBe(`Bearer ${UPSTREAM_OPENAI_KEY}`);

    const rows = logRows();
    expect(rows[0]).toMatchObject({
      protocol: 'openai',
      path: '/v1/chat/completions',
      model: 'gpt-4o-mini',
      input_tokens: 13,
      output_tokens: 21,
      stream: 0,
    });
  });

  it('propagates upstream error status and stores the error text', async () => {
    anthropicProvider();
    const errorBody = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'bad model' } });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () =>
        new Response(errorBody, { status: 400, headers: { 'content-type': 'application/json' } }),
      ),
    );

    const body = { model: 'nope', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
    });

    expect(result.response.status).toBe(400);
    expect(await result.response.text()).toBe(errorBody);
    const rows = logRows();
    expect(rows[0]?.status).toBe(400);
    expect(rows[0]?.error).toContain('bad model');
  });

  it('answers 503 and logs when no provider is configured', async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);

    const body = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
      apiKeyId: 'key-1',
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.response.status).toBe(503);
    const payload = (await result.response.json()) as {
      type: string;
      error: { type: string; message: string };
    };
    expect(payload.type).toBe('error');
    expect(payload.error.message).toContain('no enabled anthropic provider');
    const rows = logRows();
    expect(rows[0]).toMatchObject({ status: 503, upstream: null, api_key_id: 'key-1' });
    expect(rows[0]?.error).toContain('no enabled anthropic provider');
  });

  it('skips disabled providers', async () => {
    const provider = anthropicProvider();
    createProvider({
      name: 'anthropic-disabled',
      protocol: 'anthropic',
      baseUrl: 'https://disabled.example.com',
      apiKey: 'sk-disabled',
      enabled: false,
    });
    expect(provider.enabled).toBe(true);
    const fetchMock = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
    });
    expect(result.response.status).toBe(200);
    expect((fetchMock.mock.calls[0] as [string])[0]).toBe('https://api.anthropic.com/v1/messages');
  });

  it('maps network failures to 502 and still logs the row', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async () => {
        throw new TypeError('fetch failed');
      }),
    );

    const body = { model: 'claude-3', messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
      apiKeyId: 'key-net',
    });

    expect(result.response.status).toBe(502);
    const payload = (await result.response.json()) as { error: { message: string } };
    expect(payload.error.message).toContain('fetch failed');
    expect(payload.error.message).not.toContain(UPSTREAM_ANTHROPIC_KEY);
    const rows = logRows();
    expect(rows[0]).toMatchObject({ status: 502, api_key_id: 'key-net' });
    expect(rows[0]?.error).toContain('fetch failed');
  });
});

describe('relay: SSE streaming', () => {
  it('streams chunks as they arrive, before the upstream closes', async () => {
    anthropicProvider();
    const encoder = new TextEncoder();
    let releaseUpstream: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      releaseUpstream = resolve;
    });
    const upstreamBody = new ReadableStream<Uint8Array>({
      async start(controller) {
        controller.enqueue(
          encoder.encode(
            'event: message_start\ndata: {"type":"message_start","message":{"model":"claude-3-opus","usage":{"input_tokens":12,"output_tokens":1}}}\n\n',
          ),
        );
        await gate;
        controller.enqueue(
          encoder.encode(
            'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":25}}\n\n',
          ),
        );
        controller.enqueue(encoder.encode('event: message_stop\ndata: {"type":"message_stop"}\n\n'));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(upstreamBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );

    const body = { model: 'claude-3-opus', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
      apiKeyId: 'key-stream',
    });

    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    const reader = result.response.body?.getReader();
    expect(reader).toBeDefined();

    const first = await reader!.read();
    expect(first.done).toBe(false);
    expect(new TextDecoder().decode(first.value)).toContain('message_start');
    // Nothing buffered: the row is written only once the stream terminates.
    expect(logRows()).toHaveLength(0);

    releaseUpstream();
    let rest = '';
    for (;;) {
      const next = await reader!.read();
      if (next.done) break;
      rest += new TextDecoder().decode(next.value);
    }
    expect(rest).toContain('message_delta');
    expect(rest).toContain('message_stop');

    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'anthropic',
      path: '/v1/messages',
      model: 'claude-3-opus',
      status: 200,
      input_tokens: 12,
      output_tokens: 25,
      api_key_id: 'key-stream',
      stream: 1,
      error: null,
    });
  });

  it('accumulates openai usage from the trailing usage chunk', async () => {
    openaiProvider();
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"id":"1","model":"gpt-4o-mini","choices":[{"delta":{"content":"he"}}]}\n\n',
      'data: {"id":"1","model":"gpt-4o-mini","choices":[{"delta":{"content":"y"}}]}\n\n',
      'data: {"id":"1","model":"gpt-4o-mini","choices":[],"usage":{"prompt_tokens":9,"completion_tokens":4}}\n\n',
      'data: [DONE]\n\n',
    ];
    const upstreamBody = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response(upstreamBody, {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );

    const body = { model: 'gpt-4o-mini', stream: true, messages: [{ role: 'user', content: 'hi' }] };
    const result = await relay({
      protocol: 'openai',
      request: clientRequest('/api/v1/chat/completions', body),
      body,
    });

    const text = await result.response.text();
    expect(text).toBe(chunks.join(''));
    const rows = logRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      protocol: 'openai',
      model: 'gpt-4o-mini',
      input_tokens: 9,
      output_tokens: 4,
      stream: 1,
    });
  });

  it('logs the upstream error text when a stream fails mid-flight', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response('data: {"type":"error","error":{"type":"overloaded_error"}}\n\n', {
            status: 529,
            headers: { 'content-type': 'text/event-stream' },
          }),
      ),
    );
    const body = { model: 'claude-3', stream: true, messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
    });
    expect(result.response.status).toBe(529);
    await result.response.text();
    const rows = logRows();
    expect(rows[0]?.status).toBe(529);
    expect(rows[0]?.error).toContain('overloaded_error');
  });

  it('keeps the event-stream content type and disables buffering headers', async () => {
    anthropicProvider();
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(
        async () =>
          new Response('data: [DONE]\n\n', {
            status: 200,
            headers: { 'content-type': 'text/event-stream', 'content-length': '14' },
          }),
      ),
    );
    const body = { model: 'claude-3', stream: true, messages: [] };
    const result = await relay({
      protocol: 'anthropic',
      request: clientRequest('/api/v1/messages', body),
      body,
    });
    expect(result.response.headers.get('content-type')).toContain('text/event-stream');
    expect(result.response.headers.get('content-length')).toBeNull();
    expect(result.response.headers.get('x-accel-buffering')).toBe('no');
    await result.response.text();
  });
});

describe('relay: usage extraction helpers', () => {
  it('reads anthropic non-stream usage', () => {
    const snapshot = parseUsageFromJson(
      'anthropic',
      JSON.stringify({ model: 'claude-3', usage: { input_tokens: 3, output_tokens: 5 } }),
    );
    expect(snapshot).toEqual({ inputTokens: 3, outputTokens: 5, model: 'claude-3' });
  });

  it('reads openai non-stream usage', () => {
    const snapshot = parseUsageFromJson(
      'openai',
      JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 8, completion_tokens: 2 } }),
    );
    expect(snapshot).toEqual({ inputTokens: 8, outputTokens: 2, model: 'gpt-4o' });
  });

  it('tolerates malformed JSON', () => {
    expect(parseUsageFromJson('anthropic', 'not json')).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      model: null,
    });
  });

  it('accumulates anthropic SSE events and ignores [DONE]', () => {
    const snapshot: UsageSnapshot = { inputTokens: 0, outputTokens: 0, model: null };
    applySseData(
      'anthropic',
      JSON.stringify({ type: 'message_start', message: { model: 'claude-3', usage: { input_tokens: 40, output_tokens: 1 } } }),
      snapshot,
    );
    applySseData('anthropic', JSON.stringify({ type: 'message_delta', usage: { output_tokens: 60 } }), snapshot);
    applySseData('anthropic', JSON.stringify({ usage: { output_tokens: 99 } }), snapshot);
    applySseData('anthropic', '[DONE]', snapshot);
    applySseData('anthropic', 'not-json', snapshot);
    expect(snapshot).toEqual({ inputTokens: 40, outputTokens: 99, model: 'claude-3' });
  });

  it('accumulates openai SSE usage chunks', () => {
    const snapshot: UsageSnapshot = { inputTokens: 0, outputTokens: 0, model: null };
    applySseData('openai', JSON.stringify({ model: 'gpt-4o', usage: null }), snapshot);
    applySseData(
      'openai',
      JSON.stringify({ model: 'gpt-4o', usage: { prompt_tokens: 15, completion_tokens: 7 } }),
      snapshot,
    );
    applySseData('openai', '[DONE]', snapshot);
    expect(snapshot).toEqual({ inputTokens: 15, outputTokens: 7, model: 'gpt-4o' });
  });
});
