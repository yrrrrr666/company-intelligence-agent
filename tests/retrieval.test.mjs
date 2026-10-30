import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { lexicalMatch, retrievalPreview } from '../web/retrieval.mjs';
import { LibraryStore, splitLibraryText } from '../src/library.mjs';

const scope = { id: 'lexical-task', company: '关键词合成测试公司', start: '2026-01-01', end: '2026-12-31', topic: '汽车交付' };
const source = (id, text) => ({ id, title: '自主编写的合成测试公告', url: `https://example.com/${id}`, publisher: '合成测试', date: '2026-10-01', collectedAt: '2026-10-30T00:00:00Z', review: 'included', access: 'available', flagged: false, demo: false, note: '', text });
async function storeFor(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'retrieval-quality-'));
  t.after(async () => { assert.equal(path.dirname(directory), os.tmpdir()); await rm(directory, { recursive: true, force: true }); });
  return new LibraryStore({ filePath: path.join(directory, 'library.json') });
}

test('full relevant phrase and query coverage outrank repeated broad background', () => {
  const background = '本段不涉及汽车指标，只介绍其他背景。'.repeat(35);
  const evidence = '第一季度汽车交付12000辆，统计期截至3月31日。';
  assert(lexicalMatch(evidence, '汽车交付').score > lexicalMatch(background, '汽车交付').score);
  assert.equal(lexicalMatch('介绍公司办公室装修。', '请问汽车交付是多少').score, 0);
  assert.equal(lexicalMatch('只有一个年份2026。', '请问是什么').score, 0);
});

test('Latin and numeric tokens require boundaries rather than substring matches', () => {
  assert.equal(lexicalMatch('A cargo truck used API200.', 'car').score, 0);
  assert.equal(lexicalMatch('第二季度Q10车型发布。', 'Q1').score, 0);
  assert(lexicalMatch('SU7汽车第一季度Q1交付12000辆。', 'SU7 Q1').score > 0);
  assert.equal(lexicalMatch('共有120000辆。', '12000').score, 0);
});

test('Unicode normalization highlights exact original graphemes and UTF-16 positions', () => {
  const text = '🙂 ＳＵ７汽车与K系统，ﬃ模块及Cafe\u0301样本。';
  for (const query of ['SU7', 'K', 'ffi', 'Café']) {
    const result = lexicalMatch(text, query);
    assert(result.score > 0, query);
    for (const range of result.ranges) {
      assert(range.start >= 0 && range.end <= text.length);
      const slice = text.slice(range.start, range.end);
      assert(!/^[\uDC00-\uDFFF]/u.test(slice));
      assert(!/[\uD800-\uDBFF]$/u.test(slice));
    }
  }
  const fullwidth = lexicalMatch(text, 'SU7').ranges[0];
  assert.equal(text.slice(fullwidth.start, fullwidth.end), 'ＳＵ７');
});

test('match-centered context retains late evidence, preceding quarter, cumulative units and caution', () => {
  const text = '不涉及汽车指标的背景说明。'.repeat(48) + '\n第一季度（截至3月31日）。\n本季度汽车交付12000辆，累计交付30000辆；锁单不等于交付。' + '其他背景。'.repeat(15);
  assert(text.indexOf('汽车交付') > 500);
  const preview = retrievalPreview(text, '汽车交付', { offset: 100 });
  assert(preview.text.includes('第一季度'));
  assert(preview.text.includes('本季度汽车交付12000辆'));
  assert(preview.text.includes('累计交付30000辆'));
  assert(preview.text.includes('锁单不等于交付'));
  assert(preview.start > 100);
  assert(preview.text.length <= 480);
  assert.equal(preview.text, text.slice(preview.start - 100, preview.end - 100));
  assert(preview.text.indexOf('汽车交付') < 200);
  for (const range of preview.matchRanges) assert(range.start >= preview.start && range.end <= preview.end);
});

test('long sentences, empty or unmatched text and surrogate boundaries keep exact bounded context', () => {
  const text = '🙂'.repeat(260) + '季度汽车交付12000辆，累计交付30000辆' + '🙂'.repeat(260);
  const preview = retrievalPreview(text, '汽车交付', { maxLength: 200 });
  assert(preview.text.includes('汽车交付12000辆'));
  assert(preview.text.length <= 200);
  assert.equal(preview.text, text.slice(preview.start, preview.end));
  assert(!/^[\uDC00-\uDFFF]/u.test(preview.text));
  assert(!/[\uD800-\uDBFF]$/u.test(preview.text));
  assert.deepEqual(retrievalPreview('', '交付'), { text: '', start: 0, end: 0, matchRanges: [] });
  assert.deepEqual(retrievalPreview('原文没有目标词。', '交付').matchRanges, []);
  for (const options of [{ offset: -1 }, { maxLength: 0 }, { maxLength: 481 }]) assert.throws(() => retrievalPreview('测试', '测试', options));
});

test('very long merged matches do not crash and repeated highlights stay within protocol limits', () => {
  assert(lexicalMatch('汽车'.repeat(450), '汽车'.repeat(100)).score > 0);
  const largeMatch = retrievalPreview('汽车'.repeat(450), '汽车'.repeat(100));
  assert(largeMatch.text.length <= 480);
  assert(largeMatch.matchRanges.length > 0);
  const repeated = retrievalPreview('a '.repeat(450), 'a');
  assert.equal(repeated.matchRanges.length, 200);
  assert.equal(repeated.matchRanges[0].start, 0);
  assert(repeated.matchRanges.every(range => range.start >= repeated.start && range.end <= repeated.end));
});

test('strong relevant evidence ranks before a newer broad-only document with the same title', async t => {
  const library = await storeFor(t);
  const relevant = await library.save({ task: scope, source: source('specific', '第三季度汽车交付12000辆，累计交付30000辆。') });
  await library.save({ task: scope, source: source('broad', '汽车外观背景。'.repeat(60)) });
  const result = await library.search({ company: scope.company, query: '汽车交付' });
  assert.equal(result.results[0].documentId, relevant.document.id);
  assert(result.results[0].preview.text.includes('汽车交付12000辆'));
  assert.equal(result.mode, 'keyword');
});

test('retrieval preserves original chunk identities while returning the same exact focused preview as search', async t => {
  const library = await storeFor(t);
  const text = '研究背景说明。'.repeat(75) + '第一季度汽车交付12000辆，累计交付30000辆。' + '其他背景说明。'.repeat(40);
  await library.save({ task: scope, source: source('late', text) });
  const result = (await library.search({ company: scope.company, query: '汽车交付' })).results[0];
  const chunk = splitLibraryText(text).find(item => item.id === result.chunk.id);
  assert.deepEqual(result.chunk, chunk);
  assert(result.preview.start >= chunk.start && result.preview.end <= chunk.end);
  assert.equal(result.preview.text, text.slice(result.preview.start, result.preview.end));
  const retrieved = await library.retrieve({ documentId: result.documentId, version: result.version, chunkId: result.chunk.id, query: '汽车交付' });
  assert.deepEqual(retrieved.result.preview, result.preview);
});

test('overlapping chunks sharing the same matched evidence do not crowd out distinct requested evidence', async t => {
  const library = await storeFor(t);
  const text = '背景'.repeat(300) + '汽车交付100辆。' + '背景'.repeat(300);
  await library.save({ task: scope, source: source('overlap', text) });
  const result = await library.search({ company: scope.company, query: '汽车交付' });
  const rawMatches = splitLibraryText(text).filter(chunk => lexicalMatch(chunk.text, '汽车交付').score > 0);
  assert(rawMatches.length > 1);
  assert.equal(result.results.length, 1);
  await library.save({ task: scope, source: source('distinct', '第二季度汽车交付200辆。') });
  const distinct = await library.search({ company: scope.company, query: '汽车交付' });
  assert(distinct.results.some(item => item.preview.text.includes('100辆')));
  assert(distinct.results.some(item => item.preview.text.includes('200辆')));
});
