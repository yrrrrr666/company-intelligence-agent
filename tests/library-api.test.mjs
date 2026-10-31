import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';

const dir = await mkdtemp(path.join(os.tmpdir(), 'intelligence-library-api-'));
process.env.LIBRARY_PATH = path.join(dir, 'library.json');
process.env.PORT = '0';
const { server } = await import('../src/server.mjs');
let base;
const task = { id: 'api-test', company: '接口回归公司', start: '2025-01-01', end: '2025-12-31', topic: '交付' };
const source = { id: 'api-source', title: '自主编写的接口回归资料', url: 'https://example.com/api', publisher: '回归测试来源', date: '2025-05-01', text: '【自主编写的回归文本】季度汽车交付 100 辆。', collectedAt: '2026-10-30T00:00:00Z', review: 'included', flagged: false, access: 'available', demo: false, note: '测试资料' };
const post = (route, body, origin) => fetch(`${base}${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin ?? base }, body: JSON.stringify(body) });
before(async () => { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = `http://127.0.0.1:${server.address().port}`; });
after(async () => { await new Promise(resolve => server.close(resolve)); assert.equal(path.dirname(dir), os.tmpdir()); await rm(dir, { recursive: true, force: true }); });

test('library endpoints protect origins, validate inputs, hide local store and do not require model API', async () => {
  for (const route of ['/api/library/documents', '/api/library/search', '/api/library/retrieve']) assert.equal((await post(route, {}, 'https://example.com')).status, 403);
  assert.equal((await fetch(`${base}/api/library/documents`, { headers: { Origin: 'https://example.com' } })).status, 403);
  assert.equal((await fetch(`${base}/api/library/documents`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await post('/api/library/documents', {})).status, 400);
  assert.equal((await post('/api/library/documents', { task, source: { ...source, review: 'pending' } })).status, 400);
  const response = await fetch(`${base}/api/library/documents`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { documents: [], total: 0 });
  for (const url of ['/data/library.json', '/src/library.mjs']) assert.equal((await fetch(`${base}${url}`)).status, 404);
});

test('library API saves, searches, checks stale retrieval and withdraws without mutating old results', async () => {
  const archived = await post('/api/library/documents', { task, source });
  assert.equal(archived.status, 200);
  const saved = await archived.json();
  assert.equal(saved.document.version, 1);
  assert.equal((await (await post('/api/library/documents', { task, source })).json()).duplicate, true);
  const listed = await (await fetch(`${base}/api/library/documents?company=${encodeURIComponent(task.company)}`)).json();
  assert.equal(listed.total, 1);
  const found = await post('/api/library/search', { company: task.company, query: '汽车交付' });
  assert.equal(found.status, 200);
  const result = (await found.json()).results[0];
  const request = { documentId: result.documentId, version: result.version, chunkId: result.chunk.id, query: '汽车交付' };
  assert.equal((await post('/api/library/retrieve', request)).status, 200);
  assert.equal((await post(`/api/library/documents/${saved.document.id}/withdraw`, { version: 2 })).status, 409);
  assert.equal((await post(`/api/library/documents/${saved.document.id}/withdraw`, { version: 1 })).status, 200);
  const stale = await post('/api/library/retrieve', request);
  assert.equal(stale.status, 409);
  assert.equal((await stale.json()).code, 'LIBRARY_STALE_VERSION');
  assert.equal((await (await post('/api/library/search', { company: task.company, query: '汽车交付' })).json()).results.length, 0);
  assert.equal(result.source.text, source.text);
});

test('split UTF-8 characters reach the library unchanged and survive reload', async () => {
  const evidence = { ...source, id: 'split-utf8', url: 'https://example.com/split-utf8', text: '企业数据不可损坏 🚗' };
  const body = Buffer.from(JSON.stringify({ task, source: evidence }));
  // Split both a three-byte Chinese character and a four-byte emoji.
  const cuts = [body.indexOf(Buffer.from('企业数据')) + 1, body.indexOf(Buffer.from('🚗')) + 2, body.length];
  let firstChunkSeen;
  const consumed = new Promise(resolve => { firstChunkSeen = resolve; });
  const observe = incoming => incoming.once('data', () => setImmediate(firstChunkSeen));
  server.once('request', observe);
  let req;
  const response = new Promise((resolve, reject) => {
    req = httpRequest(`${base}/api/library/documents`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' } }, res => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { text += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, payload: JSON.parse(text) }));
    });
    req.on('error', reject);
  });
  try {
    req.write(body.subarray(0, cuts[0]));
    await consumed;
    req.write(body.subarray(cuts[0], cuts[1]));
    await new Promise(resolve => setTimeout(resolve, 10));
    req.end(body.subarray(cuts[1]));
    const saved = await response;
    assert.equal(saved.status, 200);
    assert.equal(saved.payload.document.source.text, evidence.text);
    const reloaded = await (await fetch(`${base}/api/library/documents/${saved.payload.document.id}`)).json();
    assert.equal(reloaded.document.source.text, evidence.text);
  } finally { req.destroy(); server.off('request', observe); }
});

test('invalid UTF-8 is rejected without saving replacement characters', async () => {
  const before = await (await fetch(`${base}/api/library/documents`)).json();
  const body = Buffer.from(JSON.stringify({ task, source: { ...source, id: 'invalid-utf8', text: '企业' } }));
  body[body.indexOf(Buffer.from('企业'))] = 0xff;
  const response = await fetch(`${base}/api/library/documents`, { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).code, 'LIBRARY_INVALID_INPUT');
  const after = await (await fetch(`${base}/api/library/documents`)).json();
  assert.deepEqual(after, before);
});
