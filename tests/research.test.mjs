import { test } from 'node:test';
import assert from 'node:assert/strict';
import { demoWorkspace, publicWebUrl, researchQuery, validateSources, eligibleSources, sourceIssues, createReport, reportMarkdown, claimSourceWarnings } from '../web/core.mjs';
import { mergeSearchCandidates, saveWebText } from '../web/research.mjs';
import { searchWeb, readWebPage } from '../src/web-research.mjs';

const { task } = demoWorkspace();
const candidate = { title: '公开公告', url: 'https://example.com/news', date: '2026-09-10', publisher: '公司公告', snippet: '搜索摘要不能作为正文' };
const page = { title: '实际页面标题', text: '【自主编写的虚构回归资料】'.repeat(20), fetchedAt: '2026-10-29T08:00:00Z', truncated: false, originalChars: 280 };

test('public reader rejects local addresses and credentials without requesting the target', () => {
  for (const url of ['http://localhost/', 'http://localhost./', 'http://app.local/', 'http://app.local./', 'http://127.0.0.1/', 'http://2130706433/', 'http://10.0.0.1/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/', 'https://user:pass@example.com/', 'https://example.com:8443/', 'file:///etc/passwd', 'javascript:alert(1)']) assert.equal(publicWebUrl(url), null, url);
  assert.equal(publicWebUrl('https://example.com/news#section'), candidate.url);
});

test('query budgets Unicode characters and expands date boundaries by a day', () => {
  const query = researchQuery({ ...task, company: '😀'.repeat(40), topic: '主题'.repeat(100) });
  assert([...query].length <= 128);
  assert.match(query, /after:2026-08-31 before:2026-10-01/);
});

test('search candidates are pending, never use summaries as evidence, and deduplicate URLs', () => {
  const result = mergeSearchCandidates([], [candidate, { ...candidate, url: `${candidate.url}?utm_source=copy` }], '检索词');
  assert.equal(result.added.length, 1);
  assert.equal(result.duplicates, 1);
  const source = result.sources[0];
  assert.equal(source.text, '');
  assert.equal(source.review, 'pending');
  assert.equal(eligibleSources([{ ...source, review: 'included' }]).length, 0);
  assert.equal(source.web.snippet, candidate.snippet);
  assert(sourceIssues(source, task, result.sources).includes('搜索提供的日期，待核实'));
  assert.doesNotThrow(() => validateSources(JSON.parse(JSON.stringify(result.sources))));
  assert.equal(mergeSearchCandidates(result.sources, [candidate]).sources[0], source);
});

test('candidate merging respects the task capacity without changing existing review choices', () => {
  const existing = Array.from({ length: 39 }, (_, index) => ({ ...mergeSearchCandidates([], [{ ...candidate, url: `https://example.com/${index}` }]).added[0], review: 'excluded' }));
  const result = mergeSearchCandidates(existing, [candidate, { ...candidate, url: 'https://example.com/overflow' }]);
  assert.equal(result.sources.length, 40);
  assert.equal(result.omitted, 1);
  assert.equal(result.sources[0], existing[0]);
  assert.equal(existing.length, 39);
  assert.equal(result.sources[0].review, 'excluded');
});

test('reading evidence preserves exclusion, notes and flags, invalidates old approval and validates provenance', () => {
  const source = { ...mergeSearchCandidates([], [candidate]).added[0], flagged: true, review: 'excluded', note: '需核对期间' };
  const result = saveWebText(source, page);
  assert.equal(result.review, 'excluded');
  assert.equal(saveWebText({ ...source, review: 'included' }, page).review, 'pending');
  assert.equal(result.flagged, true);
  assert.equal(result.note, source.note);
  assert.equal(source.text, '');
  assert.equal(result.web.dateOrigin, 'search');
  assert.throws(() => saveWebText(source, { ...page, text: '' }));
  assert.throws(() => validateSources([{ ...result, web: { ...result.web, provider: 'unknown' } }]));
});

test('every cited flagged source gets deterministic warnings even when model omits them', () => {
  const first = { ...saveWebText(mergeSearchCandidates([], [candidate]).added[0], page), review: 'included', flagged: true, note: '5月与6月表述差异，未解释' };
  const second = { ...first, id: 'second-source', flagged: false, note: '', date: '2026-09-11', web: { ...first.web, dateOrigin: 'reviewed' }, url: 'https://example.com/other' };
  const claims = [{ text: '模型没有写待核实标签', sourceIds: [first.id, second.id] }, { text: '来自第二来源', sourceIds: [second.id] }];
  const report = createReport(task, [first, second], claims);
  assert.equal(claimSourceWarnings(report, report.claims[0]).length, 1);
  assert.equal(claimSourceWarnings(report, report.claims[1]).length, 0);
  const md = reportMarkdown(report);
  assert.match(md, /来源 1 待核实：.*人工标记待核实/);
  assert.match(md, /5月与6月表述差异/);
  assert.match(md, /DeepSeek Fetch/);
  assert.match(md, /日期来源：搜索服务提供，待核实/);
  claims[0].text = 'changed';
  first.note = 'changed';
  assert.notEqual(report.claims[0].text, 'changed');
  assert.notEqual(report.sources[0].note, 'changed');
});

test('search adapter filters unsafe links, keeps unknown dates and rejects provider errors', async () => {
  const nativeFetch = globalThis.fetch;
  let request;
  try {
    globalThis.fetch = async (url, options) => {
      request = { url, ...JSON.parse(options.body) };
      return Response.json({ results: [{ ...candidate, site_name: '公开来源', date: '2026-09-10T00:00:00Z' }, { ...candidate, url: 'http://localhost/' }, { title: '无日期', url: 'https://example.com/unknown', date: 'not-a-date' }] });
    };
    const candidates = await searchWeb('公司公告', { key: 'test-only-placeholder' });
    assert.equal(request.url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(request.need_content, false);
    assert.equal(candidates.length, 2);
    assert.equal(candidates[1].date, '');
    assert.equal(candidates[0].text, undefined);
    globalThis.fetch = async () => new Response('private provider content', { status: 402 });
    await assert.rejects(searchWeb('公司', { key: 'test-only-placeholder' }), error => error.code === 'WEB_HTTP_402' && !error.message.includes('private provider'));
  } finally { globalThis.fetch = nativeFetch; }
});

test('reader uses only the fixed provider endpoint and retains truncation without inventing dates', async () => {
  const nativeFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async (url, options) => {
      calls++;
      assert.equal(url, 'https://api.deepseek.com/v1/tools/fetch');
      assert.equal(JSON.parse(options.body).url, candidate.url);
      return Response.json({ title: '原文', content: '字'.repeat(12010) });
    };
    const result = await readWebPage(candidate.url, { key: 'test-only-placeholder' });
    assert.equal(result.text.length, 12000);
    assert.equal(result.originalChars, 12010);
    assert.equal(result.truncated, true);
    assert.equal(result.date, undefined);
    await assert.rejects(readWebPage('http://localhost/', { key: 'test-only-placeholder' }));
    assert.equal(calls, 1);
    globalThis.fetch = async () => Response.json({ content: 'Forbidden' });
    await assert.rejects(readWebPage(candidate.url, { key: 'test-only-placeholder' }), error => error.code === 'WEB_NO_CONTENT');
    globalThis.fetch = async () => Response.json({ results: {} });
    await assert.rejects(searchWeb('公司', { key: 'test-only-placeholder' }), error => error.code === 'WEB_INVALID_RESPONSE');
  } finally { globalThis.fetch = nativeFetch; }
});

test('reader stops oversized provider bodies before accepting evidence', async () => {
  const nativeFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => Response.json({ content: 'x'.repeat(2 * 1024 * 1024 + 1) });
    await assert.rejects(readWebPage(candidate.url, { key: 'test-only-placeholder' }), error => error.code === 'WEB_RESPONSE_TOO_LARGE');
  } finally { globalThis.fetch = nativeFetch; }
});
