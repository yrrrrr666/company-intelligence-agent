import { test } from 'node:test';
import assert from 'node:assert/strict';
import { libraryResultSource } from '../web/library.mjs';
import { validateSources, sourceIssues, createReport, reportMarkdown, claimSourceWarnings, librarySourceLabel } from '../web/core.mjs';

function fixture() {
  const source = {
    id: 'original-1', title: '季度汽车披露', publisher: '测试公司官网',
    url: 'https://example.com/quarter', date: '2026-10-20',
    collectedAt: '2026-10-25T00:00:00.000Z',
    text: '研究背景。\n本季度交付车辆 12000 辆，累计交付 30000 辆。\n其他业务资料。',
    review: 'included', access: 'available', flagged: false, demo: false,
    note: '季度交付和累计交付口径不同，须保留。',
    file: { kind: 'pdf', name: 'test-quarter.pdf', size: 1200, sha256: 'a'.repeat(64), totalPages: 12, pageStart: 6, pageEnd: 6, extractedChars: 100, truncated: true }
  };
  const start = source.text.indexOf('本季度');
  const end = source.text.indexOf('\n其他');
  return {
    documentId: 'document-1', version: 2, company: '测试汽车公司',
    title: source.title, publisher: source.publisher, date: source.date,
    flagged: false, issues: ['文件文本已截取'],
    archivedAt: '2026-10-25T01:00:00.000Z', source,
    chunk: { id: 'chunk-1', start, end, text: source.text.slice(start, end) }
  };
}

const task = { id: 'task-2', company: '测试汽车公司', start: '2026-10-01', end: '2026-10-30', topic: '汽车交付变化' };

test('matched context import keeps exact original offsets and rejects fabricated preview text or marks', () => {
  const result = fixture();
  const start = result.chunk.start;
  const end = start + '本季度交付车辆 12000 辆，'.length;
  result.preview = { start, end, text: result.source.text.slice(start, end), matchRanges: [{ start, end: start + 3 }] };
  const imported = libraryResultSource(result, '本季度交付');
  assert.equal(imported.text, result.preview.text);
  assert.equal(imported.library.start, start);
  assert.equal(imported.library.end, end);
  assert.equal(imported.library.chunkId, result.chunk.id);
  assert.equal(imported.review, 'pending');
  for (const mutate of [
    value => { value.text += '编造'; },
    value => { value.start = result.chunk.start - 1; },
    value => { value.matchRanges[0].end = end + 1; },
    value => { value.matchRanges.push({ start, end: start + 1 }); },
    value => { value.matchRanges = null; }
  ]) {
    const broken = structuredClone(result);
    mutate(broken.preview);
    assert.throws(() => libraryResultSource(broken, '本季度交付'));
  }
});

test('legacy library rule excerpts find matched evidence after the first 500 characters without altering snapshots', () => {
  const result = fixture();
  const evidence = '2026年第三季度汽车交付12000辆，截至季末累计交付30000辆，累计并非本季。';
  result.source.text = '公司业务背景与治理说明。'.repeat(45) + evidence + '后续安排尚未确定。'.repeat(6);
  result.chunk = { id: 'chunk-1', start: 0, end: result.source.text.length, text: result.source.text };
  const imported = libraryResultSource(result, '汽车交付');
  imported.review = 'included';
  const report = createReport(task, [imported]);
  assert(report.claims[0].text.includes(evidence));
  assert(report.claims[0].text.length <= 480);
  assert.equal(report.sources[0].text, result.source.text);
  assert.equal(imported.text, result.source.text);
});

test('library imports are new pending snapshots with exact chunk, original metadata and immutable warning history', () => {
  const result = fixture();
  const imported = libraryResultSource(result, ' 汽车交付 ');
  const another = libraryResultSource(result, '汽车交付');
  assert.notEqual(imported.id, result.source.id);
  assert.notEqual(imported.id, another.id);
  assert.equal(imported.review, 'pending');
  assert.equal(imported.flagged, true);
  assert.equal(imported.text, result.source.text.slice(result.chunk.start, result.chunk.end));
  assert.deepEqual(imported.file, result.source.file);
  assert.equal(imported.note, result.source.note);
  assert.equal(imported.library.documentId, 'document-1');
  assert.equal(imported.library.version, 2);
  assert.equal(imported.library.query, '汽车交付');
  assert.equal(imported.library.originalLength, result.source.text.length);
  assert.doesNotThrow(() => validateSources([imported]));
  result.issues.push('后来添加的问题');
  result.source.file.name = 'changed.pdf';
  result.source.note = 'changed';
  assert.deepEqual(imported.library.archivedIssues, ['文件文本已截取']);
  assert.equal(imported.file.name, 'test-quarter.pdf');
  assert.notEqual(imported.note, 'changed');
});

test('library client rejects malformed, fabricated, unreviewed and nested-library evidence', () => {
  const mutations = [
    r => { r.documentId = '../escape'; },
    r => { r.version = 0; },
    r => { r.company = ''; },
    r => { r.chunk.start = -1; },
    r => { r.chunk.end += 1; },
    r => { r.chunk.text = '模型编造的不同内容'; },
    r => { r.chunk.start = 0.5; },
    r => { r.source.review = 'pending'; },
    r => { r.source.demo = true; },
    r => { r.source.access = 'failed'; },
    r => { r.source.library = {}; },
    r => { r.issues = [null]; },
    r => { r.issues = ['x'.repeat(201)]; }
  ];
  for (const mutate of mutations) {
    const result = fixture();
    mutate(result);
    assert.throws(() => libraryResultSource(result, '汽车交付'));
  }
  assert.throws(() => libraryResultSource(fixture(), ''));
  assert.throws(() => libraryResultSource(fixture(), 'x'.repeat(201)));
});

test('restored library provenance is validated and same-document chunks are not independent duplicate sources', () => {
  const first = libraryResultSource(fixture(), '汽车交付');
  const second = libraryResultSource(fixture(), '季度交付');
  second.library.chunkId = 'chunk-2';
  assert(!sourceIssues(first, task, [first, second]).includes('URL 重复候选'));
  const other = structuredClone(second);
  other.library.documentId = 'other-document';
  assert(sourceIssues(first, task, [first, other]).includes('URL 重复候选'));
  const differentCompanyTask = { ...task, company: '其他公司' };
  assert(sourceIssues(first, differentCompanyTask, [first]).includes('资料库公司与当前研究公司不同'));
  for (const key of ['start', 'end', 'originalLength']) {
    const broken = structuredClone(first);
    broken.library[key] = -1;
    assert.throws(() => validateSources([broken]));
  }
  const broken = structuredClone(first);
  broken.library.archivedIssues = [''];
  assert.throws(() => validateSources([broken]));
});

test('library report exports preserve document version, offsets, query, original PDF provenance and warnings', () => {
  const result = fixture();
  const imported = libraryResultSource(result, '汽车交付 <script>');
  imported.review = 'included';
  imported.flagged = false;
  const report = createReport(task, [imported], [{ text: '本季度交付 12000 辆。', sourceIds: [imported.id] }]);
  const markdown = reportMarkdown(report);
  const label = librarySourceLabel(imported);
  assert.match(label, /document-1/);
  assert.match(label, /版本 2/);
  assert.match(label, /chunk-1/);
  assert(label.includes(`${result.chunk.start + 1}–${result.chunk.end}`));
  assert(markdown.includes('document-1'));
  assert(markdown.includes('版本 2'));
  assert(markdown.includes('chunk-1'));
  assert(markdown.includes('汽车交付 \\<script\\>'));
  assert(markdown.includes('test-quarter.pdf'));
  assert(markdown.includes('a'.repeat(64)));
  assert(markdown.includes('文件文本已截取'));
  assert(markdown.includes('入库时'));
  assert(claimSourceWarnings(report, report.claims[0]).some(warning => warning.includes('入库时：文件文本已截取')));
  assert(report.gaps.some(gap => gap.includes('同一文档的多个片段不构成独立证据')));
  imported.library.version = 9;
  imported.library.archivedIssues.length = 0;
  imported.file.name = 'changed.pdf';
  assert.equal(report.sources[0].library.version, 2);
  assert.deepEqual(report.sources[0].library.archivedIssues, ['文件文本已截取']);
  assert.equal(report.sources[0].file.name, 'test-quarter.pdf');
});
