import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { demoWorkspace } from '../web/core.mjs';
import { libraryResultSource } from '../web/library.mjs';

process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
process.env.PORT = '0';
const callDirectory = await mkdtemp(path.join(os.tmpdir(), 'company-server-calls-'));
process.env.CALL_LOG_PATH = path.join(callDirectory, 'calls.json');
const { server } = await import('../src/server.mjs');
const nativeFetch = globalThis.fetch;
let base;
let mockResponse;
let providerCalls = 0;
let lastProviderRequest;
let mockFailure;
let webResponse;
let webGate;
let modelGate;
let modelAction;

before(async () => {
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://api.deepseek.com/v1/tools/')) {
      providerCalls++;
      lastProviderRequest = JSON.parse(options.body);
      if (webGate) await webGate;
      return Response.json(webResponse);
    }
    if (url === 'https://api.deepseek.com/chat/completions') {
      providerCalls++;
      lastProviderRequest = JSON.parse(options.body);
      if (mockFailure) throw mockFailure;
      if (modelGate) await modelGate;
      if (modelAction) await modelAction(options);
      return new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(url, options);
  };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  globalThis.fetch = nativeFetch;
  await new Promise(resolve => server.close(resolve));
  assert.equal(path.dirname(callDirectory), os.tmpdir());
  await rm(callDirectory, { recursive: true, force: true });
});

test('local server exposes only public app files and safe config', async () => {
  assert.equal((await fetch(`${base}/`)).status, 200);
  for (const file of ['/.env', '/PRD.md', '/src/server.mjs', '/.git/config']) assert.equal((await fetch(`${base}${file}`)).status, 404);
  const response = await fetch(`${base}/api/config`);
  const config = await response.json();
  assert.equal(config.modelAvailable, true);
  assert.equal(JSON.stringify(config).includes('test-only-placeholder'), false);
  assert(response.headers.get('content-security-policy').includes("script-src 'self'"));
});

test('PDF assets are self hosted through a restricted allowlist', async () => {
  for (const file of ['/import.mjs', '/vendor/pdfjs/pdf.mjs', '/vendor/pdfjs/pdf.worker.mjs']) assert.equal((await fetch(`${base}${file}`, { method: 'HEAD' })).status, 200);
  for (const file of ['/vendor/pdfjs/package.json', '/vendor/pdfjs/../../.env', '/node_modules/pdfjs-dist/package.json', '/vendor/pdfjs/cmaps/%2f..%2f..%2f.env']) assert.equal((await fetch(`${base}${file}`)).status, 404);
});

test('report rejects cross-origin and malformed requests before reaching provider', async () => {
  const beforeCalls = providerCalls;
  assert.equal((await fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: '{}' })).status, 400);
  assert.equal(providerCalls, beforeCalls);
});

test('model adapter accepts valid citations and rejects hallucinated references without real API calls', async () => {
  const input = demoWorkspace();
  input.sources[0].review = 'included';
  const post = () => fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '虚构演示摘要', sourceIds: ['demo-1'] }] }) } }] };
  const success = await post();
  assert.equal(success.status, 200);
  assert.equal((await success.json()).claims[0].sourceIds[0], 'demo-1');
  assert.equal(lastProviderRequest.thinking.type, 'disabled');
  assert.equal(lastProviderRequest.max_tokens, 6000);
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '无效引用', sourceIds: ['made-up'] }] }) } }] };
  assert.equal((await post()).status, 502);
  mockResponse = { choices: [{ message: { content: 'not json' } }] };
  assert.equal((await post()).status, 502);
});

test('model failures distinguish truncated, empty, malformed and invalid cited output', async () => {
  const input = demoWorkspace();
  input.sources[0].review = 'included';
  const valid = JSON.stringify({ claims: [{ text: '虚构演示摘要', sourceIds: ['demo-1'] }] });
  const cases = [
    [{ finish_reason: 'length', message: { content: valid } }, 'MODEL_OUTPUT_LIMIT'],
    [{ finish_reason: 'stop', message: { content: '' } }, 'MODEL_EMPTY_CONTENT'],
    [{ finish_reason: 'stop', message: { content: 'not json' } }, 'MODEL_INVALID_JSON'],
    [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [{ text: '无效引用', sourceIds: ['invented'] }] }) } }, 'MODEL_INVALID_CLAIMS']
  ];
  for (const [choice, code] of cases) {
    mockResponse = { choices: [choice] };
    const response = await fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 502);
    const result = await response.json();
    assert.equal(result.code, code);
    assert.match(result.error, /审核结果已保留/);
    assert.equal(JSON.stringify(result).includes('test-only-placeholder'), false);
    assert.equal(JSON.stringify(result).includes('not json'), false);
  }
});

test('model receives only approved library chunks and retains historical cautions even if the task flag is cleared', async () => {
  const workspace = demoWorkspace();
  const original = { ...workspace.sources[0], demo: false, review: 'included', text: '不应发送的前文。汽车季度交付 12000 辆。未被选取的后文。' };
  const start = original.text.indexOf('汽车');
  const end = original.text.indexOf('未被选取');
  const imported = libraryResultSource({ documentId: 'model-document', version: 2, company: workspace.task.company, issues: ['需核对季度口径'], source: original, chunk: { id: 'chunk-2', start, end, text: original.text.slice(start, end) } }, '季度交付');
  imported.review = 'included';
  imported.flagged = false;
  workspace.sources = [imported, { ...original, id: 'excluded-evidence', review: 'excluded' }];
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '合成回归：季度交付 12000 辆，待核实。', sourceIds: [imported.id] }] }) } }] };
  const response = await fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(workspace) });
  assert.equal(response.status, 200);
  const payload = JSON.parse(lastProviderRequest.messages.at(-1).content);
  assert.equal(payload.sources.length, 1);
  assert.equal(payload.sources[0].text, original.text.slice(start, end));
  assert.equal(payload.sources[0].needsVerification, true);
  assert.equal(payload.sources[0].library.documentId, 'model-document');
  assert.equal(payload.sources[0].library.version, 2);
  assert.deepEqual(payload.sources[0].library.archivedIssues, ['需核对季度口径']);
  assert(!JSON.stringify(payload).includes('不应发送的前文'));
  assert(!JSON.stringify(payload).includes('excluded-evidence'));
  assert.match(lastProviderRequest.messages[0].content, /同一 documentId/);
});

test('connection and timeout errors hide provider details and allow a later retry', async () => {
  const input = demoWorkspace();
  input.sources[0].review = 'included';
  const post = () => fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  for (const [name, code] of [['TimeoutError', 'MODEL_TIMEOUT'], ['TypeError', 'MODEL_CONNECTION_FAILED']]) {
    mockFailure = Object.assign(new Error('private-provider-details'), { name });
    try {
      const response = await post();
      assert.equal(response.status, 502);
      const result = await response.json();
      assert.equal(result.code, code);
      assert.match(result.error, /审核结果已保留/);
      assert.equal(JSON.stringify(result).includes('private-provider-details'), false);
    } finally { mockFailure = null; }
  }
  mockResponse = { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [{ text: '虚构演示摘要', sourceIds: ['demo-1'] }] }) } }] };
  assert.equal((await post()).status, 200);
});

test('research endpoints reject cross-origin, invalid scope and unsafe links before calling provider', async () => {
  const beforeCalls = providerCalls;
  for (const route of ['/api/search', '/api/read']) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { Origin: 'https://example.com', 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(response.status, 403);
  }
  const inputs = [
    ['/api/search', { task: { company: {}, topic: [], start: '2025-01-01', end: '2025-11-18' } }],
    ['/api/search', { task: demoWorkspace().task, query: '字'.repeat(129) }],
    ['/api/read', { url: 'http://127.0.0.1/' }],
    ['/api/read', { url: 'https://user:password@example.com/' }]
  ];
  for (const [route, body] of inputs) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(response.status, 400);
  }
  assert.equal(providerCalls, beforeCalls);
});

test('research endpoints separate candidate snippets from body and expose no credentials', async () => {
  const post = (route, body) => fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  webResponse = { results: [{ title: '虚构回归公告', url: 'https://example.com/news', snippet: '仅搜索摘要', date: '2026-09-10T00:00:00Z' }] };
  const found = await post('/api/search', { task: demoWorkspace().task });
  assert.equal(found.status, 200);
  const result = await found.json();
  assert.equal(result.candidates.length, 1);
  assert.equal(result.candidates[0].text, undefined);
  assert.equal(lastProviderRequest.need_content, false);
  assert.equal(JSON.stringify(result).includes('test-only-placeholder'), false);
  webResponse = { title: '真实读取路径的虚构测试文本', content: '【自主编写的虚构测试正文】'.repeat(20) };
  const read = await post('/api/read', { url: 'https://example.com/news' });
  assert.equal(read.status, 200);
  assert.match((await read.json()).text, /虚构测试正文/);
  webResponse = { results: [] };
  assert.deepEqual((await (await post('/api/search', { task: demoWorkspace().task })).json()).candidates, []);
});

test('simultaneous incomplete request bodies cannot bypass the research concurrency limit', async () => {
  let release;
  webGate = new Promise(resolve => { release = resolve; });
  webResponse = { title: '虚构回归正文', content: '【自主编写的虚构测试正文】'.repeat(20) };
  const beforeCalls = providerCalls;
  let observed = 0;
  let headersSeen;
  const allHeaders = new Promise(resolve => { headersSeen = resolve; });
  const observe = req => { if (req.url === '/api/read' && ++observed === 3) headersSeen(); };
  server.on('request', observe);
  const requests = [];
  const responses = [];
  try {
    for (let index = 0; index < 3; index++) {
      responses.push(new Promise((resolve, reject) => {
        const req = httpRequest(`${base}/api/read`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' } }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write('{"url":');
        requests.push(req);
      }));
    }
    await allHeaders;
    for (const req of requests) req.end('"https://example.com/news"}');
    assert.equal(await Promise.race(responses), 429);
    release();
    assert.deepEqual((await Promise.all(responses)).sort(), [200, 200, 429]);
    assert.equal(providerCalls - beforeCalls, 2);
  } finally {
    release();
    webGate = null;
    server.off('request', observe);
    for (const req of requests) req.destroy();
  }
});

test('simultaneous incomplete report bodies trigger only one model call and release the lock', { timeout: 5000 }, async () => {
  const input = demoWorkspace();
  input.sources[0].review = 'included';
  const body = JSON.stringify(input);
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '虚构回归摘要', sourceIds: ['demo-1'] }] }) } }] };
  let release;
  modelGate = new Promise(resolve => { release = resolve; });
  const beforeCalls = providerCalls;
  let observed = 0;
  let headersSeen;
  const allHeaders = new Promise(resolve => { headersSeen = resolve; });
  const observe = req => { if (req.url === '/api/report' && ++observed === 2) headersSeen(); };
  server.on('request', observe);
  const requests = [];
  const responses = [];
  try {
    for (let index = 0; index < 2; index++) {
      responses.push(new Promise((resolve, reject) => {
        const req = httpRequest(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' } }, res => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        });
        req.on('error', reject);
        req.write(body.slice(0, 10));
        requests.push(req);
      }));
    }
    await allHeaders;
    for (const req of requests) req.end(body.slice(10));
    // A missing second guard leaves both calls waiting on the provider gate.
    const first = await Promise.race([...responses, new Promise(resolve => setTimeout(() => resolve('no rejection'), 500))]);
    release();
    const statuses = await Promise.all(responses);
    assert.equal(first, 429);
    assert.equal(providerCalls - beforeCalls, 1);
    assert.deepEqual(statuses.sort(), [200, 429]);
    const retry = await fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
    assert.equal(retry.status, 200);
    assert.equal(providerCalls - beforeCalls, 2);
  } finally {
    release();
    modelGate = null;
    server.off('request', observe);
    for (const req of requests) req.destroy();
  }
});

test('oversized JSON bodies return a distinct capacity error without calling providers', async () => {
  const beforeCalls = providerCalls;
  const body = JSON.stringify({ padding: 'x'.repeat(700000) });
  for (const route of ['/api/report', '/api/search', '/api/read', '/api/library/documents']) {
    const response = await fetch(`${base}${route}`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
    assert.equal(response.status, 413, route);
    const payload = await response.json();
    assert.equal(payload.code, 'REQUEST_TOO_LARGE');
    assert.match(payload.error, /过大/);
  }
  assert.equal(providerCalls, beforeCalls);
});

test('model text budget accepts 80000 characters and rejects 80001 before provider calls', async () => {
  const input = demoWorkspace();
  input.sources = Array.from({ length: 7 }, (_, index) => ({ ...input.sources[0], id: `budget-${index}`, review: 'included', text: '字'.repeat(index < 6 ? 12000 : 8000) }));
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '虚构预算边界', sourceIds: ['budget-0'] }] }) } }] };
  const post = () => fetch(`${base}/api/report`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  const beforeCalls = providerCalls;
  assert.equal((await post()).status, 200);
  assert.equal(providerCalls - beforeCalls, 1);
  input.sources[6].text += '字';
  const rejected = await post();
  assert.equal(rejected.status, 400);
  assert.match((await rejected.json()).error, /80000/);
  assert.equal(providerCalls - beforeCalls, 1);
});

test('call history protects origins and local paths and rejects unsupported operations', async () => {
  assert.equal((await fetch(`${base}/api/calls`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/api/calls`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${base}/api/calls`, { method: 'POST', headers: { Origin: base } })).status, 405);
  assert.equal((await fetch(`${base}/api/calls?taskId=invalid%20id`)).status, 400);
  for (const target of ['/data/calls.json', '/src/calls.mjs']) assert.equal((await fetch(base + target)).status, 404);
  assert.equal((await fetch(base + '/calls.mjs')).status, 200);
});

test('search, read and report each retain one correlated record with only available provider usage', async () => {
  const workspace = demoWorkspace();
  workspace.task.id = 'trace-task';
  workspace.sources = [{ ...workspace.sources[0], review: 'included', text: 'PRIVATE_RESEARCH_BODY' }];
  const post = (route, input) => fetch(base + route, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  webResponse = { results: [] };
  const search = await post('/api/search', { task: workspace.task, query: 'PRIVATE_SEARCH_QUERY' });
  webResponse = { content: 'PRIVATE_WEB_BODY'.repeat(20), usage: { prompt_tokens: 0 } };
  const read = await post('/api/read', { taskId: workspace.task.id, sourceId: 'trace-source', url: 'https://example.com/PRIVATE_TARGET' });
  mockResponse = { id: 'provider-trace-id', model: 'fixture-model', usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, prompt_cache_hit_tokens: 0 }, choices: [{ message: { content: JSON.stringify({ claims: [{ text: 'PRIVATE_MODEL_OUTPUT', sourceIds: ['demo-1'] }] }) } }] };
  const report = await post('/api/report', workspace);
  for (const response of [search, read, report]) assert.equal(response.status, 200);
  const listed = await fetch(`${base}/api/calls?taskId=trace-task`);
  assert.equal(listed.headers.get('cache-control'), 'no-store');
  const history = await listed.json();
  assert.equal(history.records.length, 3);
  for (const response of [search, read, report]) {
    const record = history.records.find(item => item.id === response.headers.get('x-call-id'));
    assert.equal(record.status, 'succeeded');
    assert.equal(record.httpStatus, 200);
    assert(Number.isSafeInteger(record.durationMs));
    assert.equal(record.cost, null);
  }
  const modelRecord = history.records.find(item => item.operation === 'report');
  assert.equal(modelRecord.usage.inputTokens, 123);
  assert.equal(modelRecord.usage.outputTokens, 45);
  assert.equal(modelRecord.providerRequestId, 'provider-trace-id');
  assert.equal(modelRecord.model, 'fixture-model');
  assert.equal(history.records.find(item => item.operation === 'read').usage.inputTokens, 0);
  assert.equal(history.records.find(item => item.operation === 'read').sourceId, 'trace-source');
  assert.equal(history.records.find(item => item.operation === 'search').usage.inputTokens, null);
  const disk = await readFile(process.env.CALL_LOG_PATH, 'utf8');
  for (const text of ['PRIVATE_RESEARCH_BODY', 'PRIVATE_MODEL_OUTPUT', 'PRIVATE_SEARCH_QUERY', 'PRIVATE_WEB_BODY', 'PRIVATE_TARGET', 'test-only-placeholder']) {
    assert(!JSON.stringify(history).includes(text));
    assert(!disk.includes(text));
  }
  assert(!JSON.stringify(history).includes('sessionId'));
});

test('model validation failures and timeouts record safe failure codes without losing returned usage', async () => {
  const input = demoWorkspace();
  input.task.id = 'failure-log-task';
  input.sources[0].review = 'included';
  const post = () => fetch(base + '/api/report', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
  mockResponse = { usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 }, choices: [{ finish_reason: 'length' }] };
  const truncated = await post();
  assert.equal(truncated.status, 502);
  mockFailure = Object.assign(new Error('PRIVATE_PROVIDER_FAILURE'), { name: 'TimeoutError' });
  let timeout;
  try { timeout = await post(); } finally { mockFailure = null; }
  assert.equal(timeout.status, 502);
  const { records } = await (await fetch(`${base}/api/calls?taskId=failure-log-task`)).json();
  const truncatedRecord = records.find(item => item.id === truncated.headers.get('x-call-id'));
  assert.equal(truncatedRecord.errorCode, 'MODEL_OUTPUT_LIMIT');
  assert.equal(truncatedRecord.status, 'failed');
  assert.equal(truncatedRecord.usage.totalTokens, 30);
  const timeoutRecord = records.find(item => item.id === timeout.headers.get('x-call-id'));
  assert.equal(timeoutRecord.errorCode, 'MODEL_TIMEOUT');
  assert.equal(timeoutRecord.httpStatus, null);
  assert.equal(timeoutRecord.usage.totalTokens, null);
  assert(!JSON.stringify(records).includes('PRIVATE_PROVIDER_FAILURE'));
});

test('unwritable or corrupt initial logs prevent provider calls without overwriting the old file', async () => {
  const original = await readFile(process.env.CALL_LOG_PATH, 'utf8');
  const beforeCalls = providerCalls;
  const corrupted = '{original damaged log';
  await writeFile(process.env.CALL_LOG_PATH, corrupted);
  try {
    const response = await fetch(base + '/api/read', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://example.com/news' }) });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).code, 'CALL_LOG_UNAVAILABLE');
    assert.equal(providerCalls, beforeCalls);
    assert.equal(await readFile(process.env.CALL_LOG_PATH, 'utf8'), corrupted);
    assert.equal((await fetch(base + '/api/calls')).status, 503);
  } finally { await writeFile(process.env.CALL_LOG_PATH, original); }
});

test('client cancellation aborts the model request, records cancellation and frees the next generation', async () => {
  const input = demoWorkspace();
  input.task.id = 'cancel-log-task';
  input.sources[0].review = 'included';
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '虚构重试结果', sourceIds: ['demo-1'] }] }) } }] };
  let started;
  let aborted;
  const providerStarted = new Promise(resolve => { started = resolve; });
  const providerAborted = new Promise(resolve => { aborted = resolve; });
  modelAction = options => new Promise((resolve, reject) => {
    started();
    options.signal.addEventListener('abort', () => { aborted(); reject(options.signal.reason); }, { once: true });
  });
  const controller = new AbortController();
  try {
    const pending = fetch(base + '/api/report', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input), signal: controller.signal });
    await providerStarted;
    controller.abort();
    await assert.rejects(pending, error => error.name === 'AbortError');
    await providerAborted;
    modelAction = null;
    let record;
    for (let attempt = 0; attempt < 40; attempt++) {
      record = (await (await fetch(base + '/api/calls?taskId=cancel-log-task')).json()).records[0];
      if (record?.status === 'cancelled') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(record.status, 'cancelled');
    assert.equal(record.errorCode, 'CLIENT_CANCELLED');
    assert.equal(record.usage.totalTokens, null);
    const retry = await fetch(base + '/api/report', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(retry.status, 200);
  } finally { controller.abort(); modelAction = null; }
});

test('a final log write failure preserves a successful result and returns an explicit warning', async () => {
  const original = await readFile(process.env.CALL_LOG_PATH, 'utf8');
  const input = demoWorkspace();
  input.sources[0].review = 'included';
  mockResponse = { choices: [{ message: { content: JSON.stringify({ claims: [{ text: '虚构成功结果', sourceIds: ['demo-1'] }] }) } }] };
  modelAction = async () => { await writeFile(process.env.CALL_LOG_PATH, '{simulated final write failure'); };
  try {
    const response = await fetch(base + '/api/report', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.claims[0].text, '虚构成功结果');
    assert.match(payload.callLogWarning, /调用记录未能更新/);
  } finally { modelAction = null; await writeFile(process.env.CALL_LOG_PATH, original); }
});
