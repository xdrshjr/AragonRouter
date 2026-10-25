import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { MODELS_PATH, RELAY_PATHS, STRIPPED_INBOUND_HEADERS } from '@/lib/upstream';
import {
  STUB_ANTHROPIC_KEY,
  STUB_OPENAI_KEY,
  readStubState,
  resetStubState,
  startStubUpstream,
  type StubHandle,
} from './stub-harness';

/**
 * Contract tests for the offline stub upstream that `scripts/test-api.ps1` drives.
 *
 * The stub is the only upstream the end-to-end verification has, so a silent change
 * in it (port reporting, credential handling, SSE framing) turns the e2e run from
 * "proves the gateway works" into "proves nothing". Every assertion below pins one
 * half of an interface: the half the stub promises, checked against the constants
 * the real relay uses (`@/lib/upstream`), so drift on either side fails a test.
 */

let stub: StubHandle;

const jsonHeaders = (extra: Record<string, string> = {}): Record<string, string> => ({
  'content-type': 'application/json',
  ...extra,
});

describe('stub upstream (tests/integration/stub-upstream.mjs)', () => {
  beforeAll(async () => {
    stub = await startStubUpstream();
  }, 30_000);

  afterAll(async () => {
    await stub?.stop();
  });

  beforeEach(async () => {
    await resetStubState(stub.baseUrl);
  });

  describe('process contract with scripts/test-api.ps1', () => {
    it('reports the listening port as the first stdout line, as a bare integer', () => {
      const first = stub.stdoutLines.find((line) => line.trim().length > 0);
      expect(first, 'stub printed no stdout line at all').toBeDefined();
      expect(first?.trim()).toMatch(/^\d+$/);
      expect(Number.parseInt(first!.trim(), 10)).toBe(stub.port);
      expect(stub.port).toBeGreaterThan(0);
      expect(stub.port).toBeLessThan(65_536);
    });

    it('keeps diagnostics on stderr so the stdout port line stays parseable', () => {
      expect(stub.stderr()).toContain(`http://127.0.0.1:${stub.port}`);
      // No second stdout line: test-api.ps1 reads `Read-FirstLine` and parses it.
      expect(stub.stdoutLines).toHaveLength(1);
    });

    it('is reachable on loopback at the reported port', async () => {
      const response = await fetch(`${stub.baseUrl}/__stub/state`);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ count: 0, requests: [] });
    });
  });

  describe('relay target contract (C9)', () => {
    it('serves exactly the paths the gateway relays to', async () => {
      // Pinned interface: the stub hardcodes these strings, the relay derives them.
      expect(RELAY_PATHS.anthropic).toBe('/v1/messages');
      expect(RELAY_PATHS.openai).toBe('/v1/chat/completions');
      expect(MODELS_PATH).toBe('/v1/models');

      const anthropic = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: JSON.stringify({ model: 'stub-anthropic-model', max_tokens: 16, messages: [] }),
      });
      expect(anthropic.status).toBe(200);

      const openai = await fetch(`${stub.baseUrl}${RELAY_PATHS.openai}`, {
        method: 'POST',
        headers: jsonHeaders({ authorization: `Bearer ${STUB_OPENAI_KEY}` }),
        body: JSON.stringify({ model: 'stub-openai-model', messages: [] }),
      });
      expect(openai.status).toBe(200);

      const models = await fetch(`${stub.baseUrl}${MODELS_PATH}`, {
        headers: { 'x-api-key': STUB_ANTHROPIC_KEY },
      });
      expect(models.status).toBe(200);
    });

    it('serves the model ids test-api.ps1 asserts on', async () => {
      const response = await fetch(`${stub.baseUrl}${MODELS_PATH}`, {
        headers: { 'x-api-key': STUB_ANTHROPIC_KEY },
      });
      const body = (await response.json()) as { object: string; data: Array<{ id: string }> };
      expect(body.object).toBe('list');
      expect(body.data.map((model) => model.id)).toEqual(
        expect.arrayContaining(['stub-anthropic-model', 'stub-openai-model']),
      );
    });

    it('answers /v1/messages with an Anthropic message carrying usage', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: JSON.stringify({
          model: 'stub-anthropic-model',
          max_tokens: 32,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      });
      expect(response.headers.get('content-type')).toContain('application/json');
      const body = (await response.json()) as {
        type: string;
        content: Array<{ type: string; text: string }>;
        usage: { input_tokens: number; output_tokens: number };
      };
      expect(body.type).toBe('message');
      expect(body.content[0]?.text.length).toBeGreaterThan(0);
      expect(body.usage.output_tokens).toBeGreaterThan(0);
      expect(body.usage.input_tokens).toBeGreaterThan(0);
    });

    it('answers /v1/chat/completions with an OpenAI completion carrying usage', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.openai}`, {
        method: 'POST',
        headers: jsonHeaders({ authorization: `Bearer ${STUB_OPENAI_KEY}` }),
        body: JSON.stringify({ model: 'stub-openai-model', messages: [{ role: 'user', content: 'hi' }] }),
      });
      const body = (await response.json()) as {
        object: string;
        choices: Array<{ message: { content: string } }>;
        usage: { completion_tokens: number };
      };
      expect(body.object).toBe('chat.completion');
      expect(body.choices[0]?.message.content.length).toBeGreaterThan(0);
      expect(body.usage.completion_tokens).toBeGreaterThan(0);
    });
  });

  describe('upstream credential gate (C2 / C9)', () => {
    it('refuses requests without any upstream credential using the C2 error envelope', async () => {
      for (const path of [RELAY_PATHS.anthropic, RELAY_PATHS.openai]) {
        const response = await fetch(`${stub.baseUrl}${path}`, {
          method: 'POST',
          headers: jsonHeaders(),
          body: JSON.stringify({ model: 'm', messages: [] }),
        });
        expect(response.status).toBe(401);
        const body = (await response.json()) as {
          type: string;
          error: { type: string; message: string };
        };
        // Same envelope shape the gateway returns to clients (C2).
        expect(body.type).toBe('error');
        expect(body.error.type).toBe('authentication_error');
        expect(body.error.message.length).toBeGreaterThan(0);
      }
    });

    it('flags a leaked client key instead of accepting it', async () => {
      const clientKey = `ar-${'a'.repeat(32)}`;
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': clientKey }),
        body: JSON.stringify({ model: 'stub-anthropic-model', messages: [] }),
      });
      expect(response.status).toBe(401);
      const body = (await response.json()) as { error: { message: string } };
      expect(body.error.message).toContain('client credential');

      // The observation channel test-api.ps1 uses to prove "no leak, ever".
      const state = await readStubState(stub.baseUrl);
      expect(state.requests).toHaveLength(1);
      expect(state.requests[0]?.credentialLeak).toBe(true);
      expect(stub.stderr()).toContain('SECURITY');
    });

    it('records injected provider credentials so the e2e script can prove C9', async () => {
      await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' }),
        body: JSON.stringify({ model: 'stub-anthropic-model', messages: [] }),
      });
      await fetch(`${stub.baseUrl}${RELAY_PATHS.openai}`, {
        method: 'POST',
        headers: jsonHeaders({ authorization: `Bearer ${STUB_OPENAI_KEY}` }),
        body: JSON.stringify({ model: 'stub-openai-model', messages: [] }),
      });

      const state = await readStubState(stub.baseUrl);
      const anthropic = state.requests.find((record) => record.path === RELAY_PATHS.anthropic);
      const openai = state.requests.find((record) => record.path === RELAY_PATHS.openai);
      expect(anthropic?.apiKeyValue).toBe(STUB_ANTHROPIC_KEY);
      expect(anthropic?.authKind).toBe('x-api-key');
      expect(anthropic?.anthropicVersion).toBe('2023-06-01');
      expect(anthropic?.credentialLeak).toBe(false);
      expect(openai?.authorizationValue).toBe(`Bearer ${STUB_OPENAI_KEY}`);
      expect(openai?.authKind).toBe('authorization');
      expect(openai?.credentialLeak).toBe(false);
    });

    it('agrees with the relay on which inbound headers are credentials', () => {
      // If the relay stopped stripping one of these, the stub would see it as the
      // presented credential and this pair of definitions would drift apart.
      expect(STRIPPED_INBOUND_HEADERS).toContain('authorization');
      expect(STRIPPED_INBOUND_HEADERS).toContain('x-api-key');
      expect(STRIPPED_INBOUND_HEADERS).toContain('cookie');
    });
  });

  describe('streaming contract (SSE pass-through)', () => {
    it('streams the full Anthropic event sequence in order', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: JSON.stringify({ model: 'stub-anthropic-model', stream: true, messages: [] }),
      });
      expect(response.status).toBe(200);
      expect(response.headers.get('content-type')).toContain('text/event-stream');

      const text = await response.text();
      const ordered = [
        'event: message_start',
        'event: content_block_start',
        'event: content_block_delta',
        'event: content_block_stop',
        'event: message_delta',
        'event: message_stop',
      ];
      let cursor = -1;
      for (const marker of ordered) {
        const index = text.indexOf(marker);
        expect(index, `missing ${marker}`).toBeGreaterThan(-1);
        expect(index, `${marker} arrived out of order`).toBeGreaterThan(cursor);
        cursor = index;
      }
      // Every `data:` payload must be a standalone JSON document (SSE framing).
      const dataLines = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length));
      expect(dataLines.length).toBeGreaterThanOrEqual(7);
      for (const line of dataLines) {
        expect(() => JSON.parse(line)).not.toThrow();
      }
      expect(text.trimEnd().endsWith('event: message_stop\ndata: {"type":"message_stop"}')).toBe(true);
    });

    it('streams OpenAI chunks and terminates with [DONE]', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.openai}`, {
        method: 'POST',
        headers: jsonHeaders({ authorization: `Bearer ${STUB_OPENAI_KEY}` }),
        body: JSON.stringify({ model: 'stub-openai-model', stream: true, messages: [] }),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const text = await response.text();
      expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
      const payloads = text
        .split(/\r?\n/)
        .filter((line) => line.startsWith('data: '))
        .map((line) => line.slice('data: '.length))
        .filter((line) => line !== '[DONE]');
      expect(payloads.length).toBeGreaterThanOrEqual(3);
      for (const payload of payloads) {
        expect((JSON.parse(payload) as { object: string }).object).toBe('chat.completion.chunk');
      }
    });

    it('lets an explicit stream:false win over Accept: text/event-stream (same rule as wantsStream)', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY, accept: 'text/event-stream' }),
        body: JSON.stringify({ model: 'stub-anthropic-model', stream: false, messages: [] }),
      });
      expect(response.headers.get('content-type')).toContain('application/json');
      const state = await readStubState(stub.baseUrl);
      expect(state.requests[0]?.stream).toBe(false);
    });

    it('starts a stream when only Accept asks for one', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY, accept: 'text/event-stream' }),
        body: JSON.stringify({ model: 'stub-anthropic-model', messages: [] }),
      });
      expect(response.headers.get('content-type')).toContain('text/event-stream');
      const state = await readStubState(stub.baseUrl);
      expect(state.requests[0]?.stream).toBe(true);
    });
  });

  describe('malformed input handling', () => {
    it('rejects a non-JSON body with invalid_request_error', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: 'not json at all',
      });
      expect(response.status).toBe(400);
      const body = (await response.json()) as { type: string; error: { type: string } };
      expect(body.type).toBe('error');
      expect(body.error.type).toBe('invalid_request_error');
    });

    it('rejects an array body (a JSON object is required)', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: JSON.stringify([{ model: 'x' }]),
      });
      expect(response.status).toBe(400);
    });

    it('answers 404 not_found_error for an unknown route', async () => {
      const response = await fetch(`${stub.baseUrl}/v1/unknown`, {
        headers: { 'x-api-key': STUB_ANTHROPIC_KEY },
      });
      expect(response.status).toBe(404);
      const body = (await response.json()) as { error: { type: string } };
      expect(body.error.type).toBe('not_found_error');
    });

    it('does not accept a GET on the relay POST path', async () => {
      const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        headers: { 'x-api-key': STUB_ANTHROPIC_KEY },
      });
      expect(response.status).toBe(404);
    });

    it('never buffers a body above its 1 MiB cap', async () => {
      const oversized = 'x'.repeat(1024 * 1024 + 4096);
      let status: number | null = null;
      let failure: unknown = null;
      try {
        const response = await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
          method: 'POST',
          headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
          body: JSON.stringify({ model: 'stub-anthropic-model', messages: [{ role: 'user', content: oversized }] }),
        });
        status = response.status;
      } catch (error) {
        failure = error;
      }
      // Either the 413 is delivered or the stub cuts the connection mid-body; what
      // must never happen is the stub accepting (200) an oversized payload.
      if (status === null) {
        expect(failure).toBeInstanceOf(Error);
      } else {
        expect(status).toBe(413);
      }
    });
  });

  describe('observation channel', () => {
    it('records the protocol details the e2e script asserts on', async () => {
      await fetch(`${stub.baseUrl}${RELAY_PATHS.anthropic}`, {
        method: 'POST',
        headers: jsonHeaders({ 'x-api-key': STUB_ANTHROPIC_KEY }),
        body: JSON.stringify({ model: 'stub-anthropic-model', messages: [] }),
      });
      const state = await readStubState(stub.baseUrl);
      expect(state.count).toBe(1);
      const record = state.requests[0];
      expect(record?.method).toBe('POST');
      expect(record?.path).toBe(RELAY_PATHS.anthropic);
      expect(record?.model).toBe('stub-anthropic-model');
      expect(typeof record?.at).toBe('string');
      expect(Number.isNaN(Date.parse(String(record?.at)))).toBe(false);
    });

    it('reset clears the request log', async () => {
      await fetch(`${stub.baseUrl}${MODELS_PATH}`, { headers: { 'x-api-key': STUB_ANTHROPIC_KEY } });
      expect((await readStubState(stub.baseUrl)).count).toBe(1);
      await resetStubState(stub.baseUrl);
      expect((await readStubState(stub.baseUrl)).count).toBe(0);
    });
  });
});
