import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LibraryStore, splitLibraryText } from '../src/library.mjs';

const task = { id: 'test-task', company: '资料库回归公司', start: '2025-01-01', end: '2025-12-31', topic: '汽车交付与收入' };
const source = (overrides = {}) => ({ id: 'source-1', title: '自主编写的回归公告', url: 'https://example.com/quarter?utm_source=test', publisher: '测试公告来源', date: '2025-05-27', text: '【自主编写的回归文本】第一季度汽车交付 120 辆，汽车收入 300 万元，统计期截至 3 月 31 日。', collectedAt: '2026-10-30T00:00:00.000Z', review: 'included', flagged: false, access: 'available', demo: false, note: '', ...overrides });
async function setup(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'intelligence-library-test-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await rm(dir, { recursive: true, force: true }); });
  const filePath = path.join(dir, 'library.json');
  return { dir, filePath, library: new LibraryStore({ filePath }) };
}

test('library requires reviewed original evidence, keeps snapshots and persists across instances', async t => {
  const { filePath, library } = await setup(t);
  for (const invalid of [source({ review: 'pending' }), source({ review: 'excluded' }), source({ demo: true }), source({ text: '', access: 'failed' }), source({ library: { documentId: 'anything' } })]) await assert.rejects(library.save({ task, source: invalid }), { status: 400 });
  await assert.rejects(library.save({ task: { ...task, demo: true }, source: source() }), { status: 400 });
  const input = source();
  const saved = await library.save({ task, source: input });
  input.text = 'changed after saving';
  assert.equal(saved.document.source.text, source().text);
  assert.equal(saved.document.status, 'active');
  assert.equal(saved.document.version, 1);
  const reopened = new LibraryStore({ filePath });
  assert.deepEqual((await reopened.get(saved.document.id)).document, saved.document);
  saved.document.source.text = 'changed returned snapshot';
  assert.equal((await reopened.list()).documents[0].source.text, source().text);
});

test('normalized URL deduplication is independent of task IDs and preserves old revisions', async t => {
  const { filePath, library } = await setup(t);
  const initial = await library.save({ task, source: source() });
  const duplicate = await library.save({ task: { ...task, id: 'another-task' }, source: source({ id: 'different-source-id', url: 'https://example.com/quarter', collectedAt: '2026-10-30T01:00:00.000Z' }) });
  assert.equal(duplicate.document.id, initial.document.id);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.document.version, 1);
  const unchanged = await library.save({ task, source: source({ id: 'third-source-id' }) });
  assert.equal(unchanged.document.id, initial.document.id);
  const updated = await library.save({ task, source: source({ text: source().text + ' 补充：累计交付不等同于季度交付。', note: '已核查季度口径' }) });
  assert.equal(updated.document.id, initial.document.id);
  assert.equal(updated.document.version, unchanged.document.version + 1);
  assert.equal(updated.duplicate, false);
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.equal(raw.documents[0].revisions[0].source.text, source().text);
  const exact = await library.save({ task, source: updated.document.source });
  assert.equal(exact.duplicate, true);
  assert.equal(exact.document.version, updated.document.version);
});

test('file fingerprint and PDF page ranges define separate evidence and retain provenance', async t => {
  const { library } = await setup(t);
  const file = { kind: 'pdf', name: 'test-disclosure.pdf', size: 2048, sha256: 'a'.repeat(64), totalPages: 10, pageStart: 2, pageEnd: 2, extractedChars: 200, truncated: false };
  const one = await library.save({ task, source: source({ file }) });
  const two = await library.save({ task, source: source({ file: { ...file, pageStart: 3, pageEnd: 3 } }) });
  assert.notEqual(one.document.id, two.document.id);
  assert.deepEqual(one.document.source.file, file);
  const found = await library.search({ company: task.company, query: '汽车交付' });
  assert.equal(found.results.length, 2);
  assert.equal(found.results[0].source.file.sha256, file.sha256);
});

test('resaving unchanged evidence with corrected date scope versions derived warnings without losing history', async t => {
  const { filePath, library } = await setup(t);
  const initial = await library.save({ task: { ...task, start: '2025-06-01' }, source: source() });
  assert.deepEqual(initial.document.issues, ['发布时间超出研究范围']);
  assert.equal((await library.search({ company: task.company, query: '汽车交付' })).total, 0);
  const corrected = await library.save({ task, source: source() });
  assert.equal(corrected.document.id, initial.document.id);
  assert.equal(corrected.duplicate, false);
  assert.equal(corrected.document.version, 2);
  assert.deepEqual(corrected.document.issues, []);
  assert.equal((await library.search({ company: task.company, query: '汽车交付' })).results.length, 1);
  const raw = JSON.parse(await readFile(filePath, 'utf8'));
  assert.deepEqual(raw.documents[0].revisions[0].issues, ['发布时间超出研究范围']);
  const topicOnly = await library.save({ task: { ...task, topic: '销售网络' }, source: source() });
  assert.equal(topicOnly.duplicate, true);
  assert.equal(topicOnly.document.version, 2);
});

test('Chinese keyword retrieval filters company, dates, warnings and unrelated content', async t => {
  const { library } = await setup(t);
  await library.save({ task, source: source() });
  await library.save({ task: { ...task, company: '另一家公司' }, source: source() });
  await library.save({ task, source: source({ id: 'flagged', url: 'https://example.com/flagged', flagged: true, note: '需要核对' }) });
  await library.save({ task, source: source({ id: 'unknown', url: 'https://example.com/unknown', date: '' }) });
  const clean = await library.search({ company: ` ${task.company} `, query: '汽车交付' });
  assert.equal(clean.mode, 'keyword');
  assert.equal(clean.results.length, 1);
  assert.equal(clean.results[0].company, task.company);
  assert.equal((await library.search({ company: task.company, query: '汽车交付', includeFlagged: true })).results.length, 3);
  assert.equal((await library.search({ company: task.company, query: '汽车交付', includeFlagged: true, start: '2025-01-01', end: '2025-12-31' })).results.length, 2);
  assert.equal((await library.search({ company: task.company, query: '汽车交付', start: '2025-06-01' })).results.length, 0);
  assert.equal((await library.search({ company: task.company, query: '量子计算' })).results.length, 0);
  assert.equal((await library.search({ company: '不同公司', query: '汽车交付' })).results.length, 0);
  for (const changes of [{ limit: 9 }, { includeFlagged: 'true' }, { start: '2025-02-30' }, { start: '2025-10-01', end: '2025-01-01' }, { query: '字'.repeat(201) }]) await assert.rejects(library.search({ company: task.company, query: '交付', ...changes }), { status: 400 });
});

test('search excludes search-date and truncation warnings unless explicitly requested', async t => {
  const { library } = await setup(t);
  const web = { provider: 'deepseek', status: 'available', query: '测试', snippet: '摘要', error: '', truncated: false, originalChars: 100, fetchedAt: '2026-10-30T00:00:00Z', dateOrigin: 'search' };
  const saved = await library.save({ task, source: source({ web }) });
  assert(saved.document.issues.some(issue => issue.includes('搜索提供')));
  assert.equal((await library.search({ company: task.company, query: '汽车交付' })).total, 0);
  const match = (await library.search({ company: task.company, query: '汽车交付', includeFlagged: true })).results[0];
  assert.deepEqual(match.source.web, web);
  assert.deepEqual(match.issues, saved.document.issues);
});

test('retrieval rejects stale or withdrawn evidence while saved task snapshots stay unchanged', async t => {
  const { library } = await setup(t);
  const initial = await library.save({ task, source: source() });
  const match = (await library.search({ company: task.company, query: '汽车交付' })).results[0];
  const request = { documentId: match.documentId, version: match.version, chunkId: match.chunk.id, query: '汽车交付' };
  assert.equal((await library.retrieve(request)).result.chunk.text, source().text);
  await assert.rejects(library.withdraw(initial.document.id, { version: 2 }), { status: 409 });
  await library.withdraw(initial.document.id, { version: 1 });
  assert.equal((await library.search({ company: task.company, query: '汽车交付' })).total, 0);
  await assert.rejects(library.retrieve(request), { status: 409 });
  assert.equal(match.source.text, source().text);
  const restored = await library.save({ task, source: source() });
  assert.equal(restored.document.version, 2);
  assert.equal(restored.document.status, 'active');
  await assert.rejects(library.retrieve(request), { status: 409 });
});

test('chunking retains exact offsets, overlapping context, sentence boundaries and surrogate pairs', () => {
  const text = ('【回归文本】汽车交付🙂增长。' + '季度口径'.repeat(35) + '\n').repeat(25);
  const chunks = splitLibraryText(text);
  assert(chunks.length > 1);
  assert.equal(chunks[0].start, 0);
  assert.equal(chunks.at(-1).end, text.length);
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    assert(chunk.text.length <= 900);
    assert.equal(chunk.text, text.slice(chunk.start, chunk.end));
    assert(!/^[\uDC00-\uDFFF]/.test(chunk.text));
    assert(!/[\uD800-\uDBFF]$/.test(chunk.text));
    if (i) assert(chunk.start < chunks[i - 1].end);
  }
});

test('parallel writes do not lose evidence and malformed stores fail without overwriting', async t => {
  const { dir, filePath, library } = await setup(t);
  const second = new LibraryStore({ filePath });
  await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? library : second).save({ task, source: source({ id: `parallel-${i}`, url: `https://example.com/${i}` }) })));
  assert.equal((await library.list()).total, 8);
  assert.deepEqual((await readdir(dir)).sort(), ['library.json']);
  const malformed = '{broken store';
  await writeFile(filePath, malformed);
  await assert.rejects(library.list(), { status: 503, code: 'LIBRARY_UNAVAILABLE' });
  await assert.rejects(library.save({ task, source: source() }), { status: 503 });
  assert.equal(await readFile(filePath, 'utf8'), malformed);
});

test('valid JSON with malformed source, warning or historical revision also fails closed', async t => {
  const { filePath, library } = await setup(t);
  await library.save({ task, source: source() });
  await library.save({ task, source: source({ text: source().text + ' 第二版补充。' }) });
  const valid = await readFile(filePath, 'utf8');
  const changes = [
    doc => { doc.source.flagged = 'false'; },
    doc => { doc.source.unexpectedPrivateValue = 'must-not-be-returned'; },
    doc => { doc.issues = ['invented or suppressed warning']; },
    doc => { doc.revisions[0].source.text = 22; },
    doc => { doc.revisions[0].issues = []; doc.revisions[0].source.flagged = true; }
  ];
  for (const change of changes) {
    const store = JSON.parse(valid);
    change(store.documents[0]);
    const corrupted = JSON.stringify(store);
    await writeFile(filePath, corrupted);
    await assert.rejects(library.list(), { status: 503, code: 'LIBRARY_UNAVAILABLE' });
    await assert.rejects(library.save({ task, source: source() }), { status: 503 });
    assert.equal(await readFile(filePath, 'utf8'), corrupted);
  }
});
