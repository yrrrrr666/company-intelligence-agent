import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { scoreQuestion, validateAnnotation, extractArticle } from '../scripts/evaluate-retrieval.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
test('gold requires exact frozen span and anchors', () => {
  const span = { start: 2, end: 5, sha256: hash('abc'), anchors: ['ab'] };
  assert.doesNotThrow(() => validateAnnotation('xxabczz', span));
  assert.throws(() => validateAnnotation('xxabdzz', span), /fingerprint/);
  assert.throws(() => validateAnnotation('xxabczz', { ...span, anchors: ['missing'] }), /anchor/);
});
test('partial evidence and hidden previews do not count as complete', () => {
  const question = { id: 'synthetic', answerable: true, evidence: [{ sourceId: 's', start: 300, end: 400 }, { sourceId: 's', start: 800, end: 850 }] };
  const results = [{ documentId: 'd', chunk: { id: 'c', start: 0, end: 750, text: 'x'.repeat(750) }, preview: { start: 250, end: 450, text: 'x'.repeat(200) } }];
  const ids = new Map([['d', 's']]);
  const baseline = scoreQuestion(question, results, ids, 'baseline');
  const current = scoreQuestion(question, results, ids, 'current');
  assert.equal(current.hitAt5, true);
  assert.equal(current.completeAt5, false);
  assert.equal(current.chunkCovered, 1);
  assert.equal(baseline.previewCovered, 0);
  assert.equal(current.previewCovered, 1);
  assert.equal(scoreQuestion({ ...question, answerable: false, evidence: [] }, results, ids, 'current').falsePositive, true);
});
test('extractors select article body and fail closed on changed structure', () => {
  assert.equal(extractArticle('<div class="art-content"><p>A &amp; B</p><div>C</div></div><div>navigation</div>', 'xpeng-art-content-v1'), 'A & B\nC');
  assert.throws(() => extractArticle('<p>changed</p>', 'xpeng-art-content-v1'), /structure/);
});
