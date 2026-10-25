#!/usr/bin/env node
/**
 * AragonRouter 本地桩上游（integration stub upstream）。
 *
 * 用途：scripts/test-api.ps1 的端到端验证在完全离线的情况下跑通整条链路
 * （客户端 -> 网关 -> 上游），不需要真实的 Anthropic / OpenAI 凭证。
 *
 * 契约（与 scripts/test-api.ps1 约定，改动需同步两处）：
 *   1. 启动时监听 127.0.0.1 的随机空闲端口（listen(0)），并把**实际端口号单独
 *      以一行纯数字写到 stdout**，供脚本解析；其余诊断信息全部写 stderr。
 *   2. 提供与网关转发目标一致的三条上游接口：
 *        POST /v1/messages           Anthropic 协议（支持 stream:true -> SSE）
 *        POST /v1/chat/completions   OpenAI 协议（支持 stream:true -> SSE）
 *        GET  /v1/models             OpenAI 形状的模型列表
 *   3. 观测接口（仅供测试脚本断言，不参与业务逻辑）：
 *        GET  /__stub/state          返回已记录的请求摘要
 *        POST /__stub/reset          清空记录
 *   4. 鉴权：上游要求凭证。x-api-key 或 Authorization: Bearer 二者之一存在即可；
 *      如果收到以 `ar-` 开头的凭证（网关的客户端 API Key），说明网关没有剥离入站
 *      凭证 —— 这是契约 C9 的安全缺陷，桩上游直接 401 并在 stderr 报警，测试脚本
 *      也会因为期望 200 而失败。
 *
 * 安全：只绑定 127.0.0.1，请求体大小有上限，不写任何文件，不联网。
 *
 * 直接运行（人工调试）：
 *   node tests/integration/stub-upstream.mjs
 *   # stdout 输出端口号，stderr 输出可读地址
 */

import http from 'node:http';

/** 上游接口路径（与 src/lib/upstream.ts 的 RELAY_PATHS / MODELS_PATH 一致）。 */
const MESSAGES_PATH = '/v1/messages';
const CHAT_COMPLETIONS_PATH = '/v1/chat/completions';
const MODELS_PATH = '/v1/models';
const STATE_PATH = '/__stub/state';
const RESET_PATH = '/__stub/reset';

/** 请求体上限：防止桩上游被超大请求拖垮（真实上游也会限制）。 */
const MAX_BODY_BYTES = 1024 * 1024;
/** 单条记录保留的请求条数。 */
const MAX_RECORDS = 100;
/** SSE 分块之间的间隔，用来证明网关是逐块透传而不是整体缓冲。 */
const CHUNK_DELAY_MS = Number.parseInt(process.env.STUB_CHUNK_DELAY_MS ?? '8', 10) || 8;
/**
 * 故障演练开关（默认关闭）：记录到第 N 个上游请求后立刻退出，用来复现"桩上游中途挂掉"。
 * tests/integration/scripts-runtime.test.ts 用它验证 scripts/test-api.ps1 在链路中途失败时
 * 仍然会停下来、释放端口；正常使用与其它测试都不设置该变量。
 */
const EXIT_AFTER_REQUESTS = Number.parseInt(process.env.STUB_EXIT_AFTER_REQUESTS ?? '0', 10) || 0;
/** 已记录的请求数（独立于 records 的滑动窗口，避免 MAX_RECORDS 截断后触发不了演练）。 */
let recordedCount = 0;

/** 模型目录：两种协议的 provider 都会命中同一份列表。 */
const MODELS = [
  { id: 'stub-anthropic-model', object: 'model', created: 1700000000, owned_by: 'aragon-stub' },
  { id: 'stub-openai-model', object: 'model', created: 1700000000, owned_by: 'aragon-stub' },
];

const records = [];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(message) {
  process.stderr.write(`[stub-upstream] ${message}\n`);
}

function sendJson(response, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
    ...extraHeaders,
  });
  response.end(body);
}

/** C2 形状的上游错误（Anthropic 兼容），便于网关原样透传。 */
function sendAuthError(response, message) {
  sendJson(response, 401, {
    type: 'error',
    error: { type: 'authentication_error', message },
  });
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    let settled = false;
    request.on('data', (chunk) => {
      if (settled) return;
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        settled = true;
        reject(Object.assign(new Error('request body too large'), { statusCode: 413 }));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function parseJsonObject(text) {
  if (!text || text.trim().length === 0) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function bearerToken(header) {
  if (typeof header !== 'string') return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match && match[1] ? match[1].trim() : null;
}

/**
 * 记录一次上游收到的请求，并返回本次请求的观测信息。
 * 这里刻意保留凭证的最小指纹（是否以 ar- 开头 / 长度），不保存完整值。
 */
function record(entry) {
  records.push(entry);
  while (records.length > MAX_RECORDS) records.shift();
  recordedCount += 1;
  // 故障演练：让进程在链路中途消失（下一次请求会直接 ECONNREFUSED），
  // 用于验证网关侧的失败语义以及 test-api.ps1 的收尾停机。
  if (EXIT_AFTER_REQUESTS > 0 && recordedCount >= EXIT_AFTER_REQUESTS) {
    log(`STUB_EXIT_AFTER_REQUESTS=${EXIT_AFTER_REQUESTS} reached after ${recordedCount} request(s), exiting (failure drill)`);
    // 留一点时间让当前请求的响应写出去，再让进程消失：这样演练的是"中途挂掉"，
    // 而不是"连第一个请求都没应答"。
    setTimeout(() => process.exit(0), 250);
  }
  return entry;
}

function wantsStream(body, request) {
  if (body && typeof body === 'object' && 'stream' in body) return body.stream === true;
  const accept = request.headers.accept ?? '';
  return typeof accept === 'string' && accept.includes('text/event-stream');
}

/** 上游侧鉴权：必须收到网关注入的凭证，且绝不接受网关的客户端 Key（ar-...）。 */
function checkCredentials(request, response) {
  const apiKey = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'].trim() : '';
  const token = bearerToken(request.headers.authorization);
  const presented = apiKey || token || '';

  if (!presented) {
    log(`401 missing upstream credential for ${request.url}`);
    sendAuthError(response, 'invalid x-api-key');
    return false;
  }
  if (presented.startsWith('ar-')) {
    // C9 违规：网关把客户端的 API Key 泄漏给了上游。
    log('SECURITY: received a client API key (ar-...) instead of the provider credential');
    sendAuthError(response, 'client credential must never reach the upstream');
    return false;
  }
  return true;
}

function buildAnthropicMessage(model) {
  return {
    id: 'msg_stub_0001',
    type: 'message',
    role: 'assistant',
    model: model || 'stub-anthropic-model',
    content: [{ type: 'text', text: 'Hello from the AragonRouter stub upstream.' }],
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 11, output_tokens: 9 },
  };
}

function buildOpenAiCompletion(model) {
  return {
    id: 'chatcmpl-stub-0001',
    object: 'chat.completion',
    created: 1700000000,
    model: model || 'stub-openai-model',
    choices: [
      {
        index: 0,
        message: { role: 'assistant', content: 'Hello from the AragonRouter stub upstream.' },
        finish_reason: 'stop',
      },
    ],
    usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
  };
}

/** Anthropic 形状的 SSE 流：message_start / content_block_delta / message_delta / message_stop。 */
async function streamAnthropic(response, model) {
  const resolvedModel = model || 'stub-anthropic-model';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const events = [
    [
      'event: message_start',
      `data: ${JSON.stringify({
        type: 'message_start',
        message: {
          id: 'msg_stub_stream_0001',
          type: 'message',
          role: 'assistant',
          model: resolvedModel,
          content: [],
          usage: { input_tokens: 11, output_tokens: 0 },
        },
      })}`,
    ],
    [
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      })}`,
    ],
    [
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'Hello' },
      })}`,
    ],
    [
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: ' from the stub upstream.' },
      })}`,
    ],
    ['event: content_block_stop', `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`],
    [
      'event: message_delta',
      `data: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: 7 },
      })}`,
    ],
    ['event: message_stop', `data: ${JSON.stringify({ type: 'message_stop' })}`],
  ];

  for (const [head, data] of events) {
    if (response.writableEnded || response.destroyed) return;
    response.write(`${head}\n${data}\n\n`);
    await sleep(CHUNK_DELAY_MS);
  }
  response.end();
}

/** OpenAI 形状的 SSE 流：若干 chunk 后以 [DONE] 结束。 */
async function streamOpenAi(response, model) {
  const resolvedModel = model || 'stub-openai-model';
  response.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
  });

  const chunks = [
    {
      id: 'chatcmpl-stub-stream-0001',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: resolvedModel,
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-stub-stream-0001',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: resolvedModel,
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    },
    {
      id: 'chatcmpl-stub-stream-0001',
      object: 'chat.completion.chunk',
      created: 1700000000,
      model: resolvedModel,
      choices: [{ index: 0, delta: { content: ' from the stub upstream.' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 11, completion_tokens: 9, total_tokens: 20 },
    },
  ];

  for (const chunk of chunks) {
    if (response.writableEnded || response.destroyed) return;
    response.write(`data: ${JSON.stringify(chunk)}\n\n`);
    await sleep(CHUNK_DELAY_MS);
  }
  if (response.writableEnded || response.destroyed) return;
  response.write('data: [DONE]\n\n');
  response.end();
}

async function handle(request, response) {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  const method = (request.method ?? 'GET').toUpperCase();

  if (path === RESET_PATH && (method === 'POST' || method === 'GET')) {
    records.length = 0;
    sendJson(response, 200, { ok: true });
    return;
  }

  if (path === STATE_PATH && method === 'GET') {
    const snapshot = records.slice();
    sendJson(response, 200, {
      count: snapshot.length,
      requests: snapshot,
    });
    return;
  }

  // 观测记录：路径、协议、凭证形态（不落明文）、是否来自网关的入站凭证泄漏。
  const apiKey = typeof request.headers['x-api-key'] === 'string' ? request.headers['x-api-key'].trim() : '';
  const token = bearerToken(request.headers.authorization);
  const presented = apiKey || token || '';
  const entry = record({
    method,
    path,
    at: new Date().toISOString(),
    authKind: apiKey ? 'x-api-key' : token ? 'authorization' : 'none',
    apiKeyValue: apiKey,
    authorizationValue: typeof request.headers.authorization === 'string' ? request.headers.authorization : '',
    credentialLeak: presented.startsWith('ar-'),
    anthropicVersion: typeof request.headers['anthropic-version'] === 'string' ? request.headers['anthropic-version'] : '',
    accept: typeof request.headers.accept === 'string' ? request.headers.accept : '',
    contentType: typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '',
    stream: false,
    model: null,
  });

  if (!checkCredentials(request, response)) return;

  if (path === MODELS_PATH && method === 'GET') {
    sendJson(response, 200, { object: 'list', data: MODELS });
    return;
  }

  if (path === MESSAGES_PATH && method === 'POST') {
    let text;
    try {
      text = await readBody(request);
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: error.message },
      });
      return;
    }
    const body = parseJsonObject(text);
    if (!body) {
      sendJson(response, 400, {
        type: 'error',
        error: { type: 'invalid_request_error', message: 'request body must be a JSON object' },
      });
      return;
    }
    entry.stream = wantsStream(body, request);
    entry.model = typeof body.model === 'string' ? body.model : null;
    if (entry.stream) {
      await streamAnthropic(response, entry.model);
      return;
    }
    sendJson(response, 200, buildAnthropicMessage(entry.model));
    return;
  }

  if (path === CHAT_COMPLETIONS_PATH && method === 'POST') {
    let text;
    try {
      text = await readBody(request);
    } catch (error) {
      sendJson(response, error.statusCode ?? 400, {
        error: { type: 'invalid_request_error', message: error.message },
      });
      return;
    }
    const body = parseJsonObject(text);
    if (!body) {
      sendJson(response, 400, {
        error: { type: 'invalid_request_error', message: 'request body must be a JSON object' },
      });
      return;
    }
    entry.stream = wantsStream(body, request);
    entry.model = typeof body.model === 'string' ? body.model : null;
    if (entry.stream) {
      await streamOpenAi(response, entry.model);
      return;
    }
    sendJson(response, 200, buildOpenAiCompletion(entry.model));
    return;
  }

  sendJson(response, 404, {
    type: 'error',
    error: { type: 'not_found_error', message: `no stub route for ${method} ${path}` },
  });
}

const server = http.createServer((request, response) => {
  handle(request, response).catch((error) => {
    log(`unhandled error on ${request.method} ${request.url}: ${error && error.message}`);
    if (!response.headersSent) {
      sendJson(response, 500, {
        type: 'error',
        error: { type: 'api_error', message: 'internal stub error' },
      });
      return;
    }
    try {
      response.destroy();
    } catch {
      // 连接已断开，忽略
    }
  });
});

server.on('error', (error) => {
  log(`server error: ${error && error.message}`);
  process.exit(1);
});

server.listen(0, '127.0.0.1', () => {
  const address = server.address();
  const port = address && typeof address === 'object' ? address.port : 0;
  if (!port) {
    log('failed to bind an ephemeral port');
    process.exit(1);
  }
  // 契约：stdout 只输出一行纯数字端口，供 scripts/test-api.ps1 解析。
  process.stdout.write(`${port}\n`);
  log(`listening on http://127.0.0.1:${port} (stdout carries the port number)`);
});

function shutdown(signal) {
  log(`received ${signal}, shutting down`);
  server.close(() => process.exit(0));
  // 兜底：连接迟迟不释放时强制退出（测试脚本随后会清理进程树）。
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
