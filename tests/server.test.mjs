import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { demoWorkspace } from '../web/core.mjs';
import { libraryResultSource } from '../web/library.mjs';

process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
process.env.PORT = '0';
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
      return new Response(JSON.stringify(mockResponse), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return nativeFetch(url, options);
  };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { globalThis.fetch = nativeFetch; await new Promise(resolve => server.close(resolve)); });

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
    assert.equal(providerCalls - beforeCalls, 2);
    release();
    assert.deepEqual((await Promise.all(responses)).sort(), [200, 200, 429]);
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
