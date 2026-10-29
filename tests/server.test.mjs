import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { demoWorkspace } from '../web/core.mjs';

process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
process.env.PORT = '0';
const { server } = await import('../src/server.mjs');
const nativeFetch = globalThis.fetch;
let base;
let mockResponse;
let providerCalls = 0;
let lastProviderRequest;
let mockFailure;

before(async () => {
  globalThis.fetch = async (url, options) => {
    if (url === 'https://api.deepseek.com/chat/completions') {
      providerCalls++;
      lastProviderRequest = JSON.parse(options.body);
      if (mockFailure) throw mockFailure;
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
