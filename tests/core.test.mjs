import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateTask, isDate, normalizeUrl, safeUrl, sourceIssues, validateSources, validateModelClaims, createReport, reportMarkdown, demoWorkspace } from '../web/core.mjs';

test('task validates required fields, calendar dates and reversed range', () => {
  assert.equal(Object.keys(validateTask({})).length, 4);
  assert.equal(isDate('2026-02-30'), false);
  assert.equal(isDate('2024-02-29'), true);
  assert.match(validateTask({ company: '公司', topic: '产品', start: '2026-10-02', end: '2026-10-01' }).end, /早于/);
});

test('URLs reject executable schemes and credentials; dedup retains meaningful parameters', () => {
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('https://user:pass@example.com/'), null);
  assert.equal(normalizeUrl('https://example.com/news?utm_source=x&id=1#body'), normalizeUrl('https://example.com/news?id=1'));
  assert.notEqual(normalizeUrl('https://example.com/news?id=1'), normalizeUrl('https://example.com/news?id=2'));
});

test('review flags unknown dates, range violations, duplicates and unavailable text', () => {
  const { task, sources } = demoWorkspace();
  assert(sourceIssues(sources[2], task, sources).includes('发布时间未知'));
  assert(sourceIssues(sources[3], task, sources).includes('发布时间超出研究范围'));
  assert(sourceIssues(sources[4], task, sources).includes('没有可用正文'));
  sources[0].url = 'https://example.com/article?utm_source=x';
  sources[1].url = 'https://example.com/article';
  assert(sourceIssues(sources[0], task, sources).includes('URL 重复候选'));
});

test('reports use only included readable sources and keep immutable evidence snapshots', () => {
  const { task, sources } = demoWorkspace();
  assert.throws(() => createReport(task, sources), /先纳入/);
  sources[0].review = 'included';
  sources[1].review = 'excluded';
  sources[4].review = 'included';
  const report = createReport(task, sources);
  assert.deepEqual(report.sources.map(source => source.id), ['demo-1']);
  assert(report.gaps.some(gap => gap.includes('虚构')));
  const markdown = reportMarkdown(report);
  assert(markdown.includes('[来源 1](#source-1)'));
  assert(!markdown.includes('示例制造'));
  assert(markdown.includes('保存文本：'));
  sources[0].text = 'changed';
  task.company = 'changed';
  assert.notEqual(report.sources[0].text, 'changed');
  assert.notEqual(report.task.company, 'changed');
});

test('model output rejects unknown, excluded and missing citation IDs', () => {
  const { sources } = demoWorkspace();
  sources[0].review = 'included';
  for (const sourceIds of [[], ['invented'], ['demo-2']]) assert.throws(() => validateModelClaims({ claims: [{ text: '结论', sourceIds }] }, sources));
  assert.deepEqual(validateModelClaims({ claims: [{ text: '有来源的结论', sourceIds: ['demo-1'] }] }, sources)[0].sourceIds, ['demo-1']);
});

test('source validation rejects corrupt stored state and unsafe links', () => {
  const { sources } = demoWorkspace();
  assert.doesNotThrow(() => validateSources(sources));
  assert.throws(() => validateSources([{ ...sources[0], text: 42 }]));
  assert.throws(() => validateSources([{ ...sources[0], url: 'javascript:alert(1)' }]));
  assert.throws(() => validateSources([sources[0], sources[0]]));
});

test('export escapes untrusted Markdown and URL delimiters', () => {
  const { task, sources } = demoWorkspace();
  task.company = '<script>evil</script>';
  sources[0].review = 'included';
  sources[0].title = '[injection](javascript:alert(1))';
  sources[0].url = 'https://example.com/path(test)';
  sources[0].text = '<img src=x onerror=alert(1)> [x](javascript:evil)';
  const markdown = reportMarkdown(createReport(task, sources));
  assert(markdown.includes('\\<script\\>'));
  assert(markdown.includes('\\[injection\\]'));
  assert(markdown.includes('path%28test%29'));
  assert(!/(?<!\\)<img/.test(markdown));
});
