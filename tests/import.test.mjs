import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkLocalFile, decodeLocalText, prepareImportText, validatePageRange, openLocalFile, MAX_FILE_BYTES } from '../web/import.mjs';
import { demoWorkspace, validateSources, sourceIssues, createReport, reportMarkdown } from '../web/core.mjs';

test('file selection rejects unsupported, empty and oversized files', () => {
  for (const [name, size] of [['test.docx', 30], ['test.txt', 0], ['test.pdf', MAX_FILE_BYTES + 1]]) assert.throws(() => checkLocalFile({ name, size }));
  assert.doesNotThrow(() => checkLocalFile({ name: '研究.PDF', size: MAX_FILE_BYTES }));
});

test('text import decodes UTF-8/GB18030 and rejects binary content', () => {
  assert.equal(decodeLocalText(new TextEncoder().encode('\uFEFF中文\r\n正文')), '中文\n正文');
  assert.equal(decodeLocalText(Uint8Array.from([0xb2, 0xe2, 0xca, 0xd4])), '测试');
  assert.equal(decodeLocalText(Uint8Array.from([0xff, 0xfe, 0x2d, 0x4e, 0x87, 0x65])), '中文');
  assert.throws(() => decodeLocalText(Uint8Array.from([0, 1, 2])));
});

test('text limits retain original length and disclose truncation', () => {
  const result = prepareImportText('中'.repeat(12001));
  assert.equal(result.text.length, 12000);
  assert.equal(result.extractedChars, 12001);
  assert.equal(result.truncated, true);
});

test('PDF page selection rejects reversed, fractional, oversized and outside ranges', () => {
  for (const [start, end] of [[0, 1], [3, 2], [1.5, 2], [1, 201], [1, 101]]) assert.throws(() => validatePageRange(start, end, 200));
  assert.doesNotThrow(() => validatePageRange(6, 6, 48));
});

test('text opening records a content fingerprint without interpreting file modification time as publication', async () => {
  const first = await openLocalFile(new File(['企业公开资料'], '资料.txt', { lastModified: 0 }));
  const second = await openLocalFile(new File(['企业公开资料'], '改名.md'));
  assert.equal(first.sha256, second.sha256);
  assert.match(first.sha256, /^[a-f0-9]{64}$/);
  assert.equal(first.kind, 'text');
  assert.equal(first.date, undefined);
});

test('local evidence validates, deduplicates by file and page range, and exports its provenance', () => {
  const { task, sources } = demoWorkspace();
  const file = { name: '研究.pdf', size: 900, sha256: 'a'.repeat(64), kind: 'pdf', totalPages: 46, pageStart: 6, pageEnd: 6, extractedChars: 12001, truncated: true };
  const source = { ...sources[0], demo: false, review: 'included', file };
  const duplicate = { ...source, id: 'local-copy' };
  assert.doesNotThrow(() => validateSources([source]));
  assert(sourceIssues(source, task, [source, duplicate]).includes('本地文件重复候选'));
  assert(sourceIssues(source, task, [source]).includes('文件文本已截取'));
  duplicate.file = { ...file, pageStart: 7, pageEnd: 7 };
  assert(!sourceIssues(source, task, [source, duplicate]).includes('本地文件重复候选'));
  assert.throws(() => validateSources([{ ...source, file: { ...file, pageEnd: 99 } }]));
  assert.throws(() => validateSources([{ ...source, file: { ...file, sha256: '<script>' } }]));
  const report = createReport(task, [source]);
  const markdown = reportMarkdown(report);
  assert(markdown.includes('研究.pdf'));
  assert(markdown.includes('第 6–6 页 / 共 46 页'));
  assert(markdown.includes(`SHA-256：${file.sha256}`));
  assert(markdown.includes('本地文件，未提供外部链接'));
  assert(!markdown.includes('无外部链接（虚构演示'));
  source.file.name = 'changed.pdf';
  assert.equal(report.sources[0].file.name, '研究.pdf');
});
