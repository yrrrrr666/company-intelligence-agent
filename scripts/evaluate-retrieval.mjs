import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { performance } from 'node:perf_hooks';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const evaluationDir = path.join(root, 'evals/retrieval-v0.5.1');
const outputDir = path.join(root, 'outputs/v0.5.1-eval');
const corpusDir = path.join(outputDir, 'corpus');
const sha256 = text => createHash('sha256').update(text).digest('hex');

export function htmlText(html) {
  const named = { nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', middot: '·', bull: '•', ensp: ' ', emsp: ' ', thinsp: ' ' };
  return html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|li|h[1-6]|tr|div)>/gi, '\n').replace(/<\/(?:td|th)>/gi, ' | ')
    .replace(/<[^>]*>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (original, key) => {
      if (key[0] === '#') { const n = key[1].toLowerCase() === 'x' ? parseInt(key.slice(2), 16) : parseInt(key.slice(1), 10); return n <= 0x10ffff ? String.fromCodePoint(n) : original; }
      return named[key.toLowerCase()] ?? original;
    }).replace(/\r/g, '').split('\n').map(line => line.replace(/[\t \u00a0]+/g, ' ').trim()).filter(Boolean).join('\n');
}

export function extractArticle(html, extractor) {
  if (extractor === 'nio-next-news-content-v1') {
    const match = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (!match) throw new Error('NIO official page no longer has the pinned article structure');
    const news = JSON.parse(match[1]).props?.pageProps?.news;
    if (typeof news?.content !== 'string') throw new Error('Missing NIO article body');
    return htmlText(news.content);
  }
  if (extractor === 'xpeng-art-content-v1') {
    const start = /<div\b[^>]*class="art-content"[^>]*>/i.exec(html);
    if (!start) throw new Error('XPENG official page no longer has the pinned article structure');
    const tail = html.slice(start.index + start[0].length);
    const tags = /<\/?div\b[^>]*>/gi;
    let depth = 1;
    for (const tag of tail.matchAll(tags)) { depth += /^<\//.test(tag[0]) ? -1 : 1; if (!depth) return htmlText(tail.slice(0, tag.index)); }
    throw new Error('Unclosed XPENG article container');
  }
  throw new Error('Unknown extraction recipe');
}

export function validateAnnotation(text, span) {
  if (!Number.isSafeInteger(span.start) || !Number.isSafeInteger(span.end) || span.start < 0 || span.end <= span.start || span.end > text.length) throw new Error('Annotation range invalid');
  const selected = text.slice(span.start, span.end);
  if (sha256(selected) !== span.sha256) throw new Error('Annotation fingerprint changed');
  if (span.anchors.some(anchor => !selected.includes(anchor))) throw new Error('Annotation anchor missing');
}

const covers = (range, span) => range.start <= span.start && range.end >= span.end;
export function scoreQuestion(question, results, sourceIdByDocument, mode) {
  const top = results.slice(0, 5);
  const spans = question.evidence || [];
  const ranges = kind => top.map(result => ({
    sourceId: sourceIdByDocument.get(result.documentId),
    start: kind === 'preview' && mode === 'current' ? result.preview?.start ?? result.chunk.start : result.chunk.start,
    end: kind === 'preview' && mode === 'current' ? result.preview?.end ?? result.chunk.end : kind === 'preview' ? Math.min(result.chunk.end, result.chunk.start + 180) : kind === 'rule' && mode === 'baseline' ? Math.min(result.chunk.end, result.chunk.start + 500) : kind === 'rule' ? result.preview?.end ?? result.chunk.end : result.chunk.end
  })).map((range, i) => kind === 'rule' && mode === 'current' ? { ...range, start: top[i].preview?.start ?? range.start } : range);
  const covered = kind => spans.filter(span => ranges(kind).some(range => range.sourceId === span.sourceId && covers(range, span))).length;
  const prefix480Covered = spans.filter(span => top.some(result => sourceIdByDocument.get(result.documentId) === span.sourceId && covers({ start: result.chunk.start, end: Math.min(result.chunk.end, result.chunk.start + 480) }, span))).length;
  const isRelevant = result => spans.some(span => sourceIdByDocument.get(result.documentId) === span.sourceId && covers(result.chunk, span));
  let overlapPairs = 0;
  for (let i = 0; i < top.length; i++) for (let j = i + 1; j < top.length; j++) {
    if (top[i].documentId === top[j].documentId && Math.max(top[i].chunk.start, top[j].chunk.start) < Math.min(top[i].chunk.end, top[j].chunk.end)) overlapPairs++;
  }
  return { id: question.id, answerable: question.answerable, category: question.category, returned: top.length,
    hitAt1: spans.length > 0 && !!top[0] && isRelevant(top[0]), hitAt5: covered('chunk') > 0,
    requiredSpans: spans.length, prefix480Covered, prefix480CompleteAt5: spans.length > 0 && prefix480Covered === spans.length, chunkCovered: covered('chunk'), previewCovered: covered('preview'), ruleCovered: covered('rule'),
    completeAt5: spans.length > 0 && covered('chunk') === spans.length,
    previewCompleteAt5: spans.length > 0 && covered('preview') === spans.length,
    ruleCompleteAt5: spans.length > 0 && covered('rule') === spans.length,
    labelledRelevantChunks: top.filter(isRelevant).length, overlappingPairs: overlapPairs,
    falsePositive: !question.answerable && top.length > 0,
    failures: [...(question.answerable && !covered('chunk') ? ['no-gold-span-in-top5'] : []), ...(question.answerable && covered('chunk') < spans.length ? ['incomplete-required-evidence'] : []), ...(question.answerable && covered('preview') < spans.length ? ['preview-hides-required-evidence'] : []), ...(!question.answerable && top.length ? ['no-answer-returned-chunks'] : [])],
    results: top.map(result => ({ score: result.score ?? null, text: result.chunk.text, previewText: result.preview?.text ?? null, matchRanges: result.preview?.matchRanges ?? [], sourceId: sourceIdByDocument.get(result.documentId), chunkId: result.chunk.id, chunk: { start: result.chunk.start, end: result.chunk.end }, preview: result.preview ? { start: result.preview.start, end: result.preview.end } : null })) };
}

function aggregate(rows) {
  const positives = rows.filter(row => row.answerable);
  const controls = rows.filter(row => !row.answerable);
  const relevant = positives.reduce((n, row) => n + row.labelledRelevantChunks, 0);
  const returned = positives.reduce((n, row) => n + row.returned, 0);
  return { positiveQuestions: positives.length, noAnswerQuestions: controls.length,
    hitAt1: positives.filter(row => row.hitAt1).length, hitAt5: positives.filter(row => row.hitAt5).length,
    completeAt5: positives.filter(row => row.completeAt5).length, previewCompleteAt5: positives.filter(row => row.previewCompleteAt5).length,
    ruleCompleteAt5: positives.filter(row => row.ruleCompleteAt5).length,
    prefix480Covered: positives.reduce((n, row) => n + row.prefix480Covered, 0), prefix480CompleteAt5: positives.filter(row => row.prefix480CompleteAt5).length,
    requiredSpans: positives.reduce((n, row) => n + row.requiredSpans, 0), chunkCovered: positives.reduce((n, row) => n + row.chunkCovered, 0),
    previewCovered: positives.reduce((n, row) => n + row.previewCovered, 0), ruleCovered: positives.reduce((n, row) => n + row.ruleCovered, 0),
    labelledRelevantChunks: relevant, positiveReturnedChunks: returned, labelledPrecisionAt5: returned ? relevant / returned : 0,
    noAnswerFalsePositives: controls.filter(row => row.falsePositive).length,
    overlappingPairs: positives.reduce((n, row) => n + row.overlappingPairs, 0) };
}

async function loadCorpus(manifest, shouldFetch) {
  await mkdir(corpusDir, { recursive: true });
  const corpus = new Map();
  for (const source of manifest.sources) {
    const target = path.join(corpusDir, `${source.id}.txt`);
    let text;
    if (shouldFetch) {
      const response = await fetch(source.url, { signal: AbortSignal.timeout(30000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!response.ok) throw new Error(`Official source ${source.id} returned HTTP ${response.status}; no replacement corpus was used`);
      const html = await response.text();
      if (html.length > 2 * 1024 * 1024) throw new Error(`Official source ${source.id} too large`);
      text = extractArticle(html, source.extractor);
      if (sha256(text) !== source.sha256 || text.length !== source.textLength) throw new Error(`Official source ${source.id} changed; fixed labels were not updated automatically`);
      await writeFile(path.join(corpusDir, `${source.id}.html`), html, 'utf8');
      await writeFile(target, text, 'utf8');
    } else {
      try { text = await readFile(target, 'utf8'); }
      catch { throw new Error(`Missing pinned corpus ${source.id}; first run node scripts/evaluate-retrieval.mjs --fetch`); }
    }
    if (sha256(text) !== source.sha256 || text.length !== source.textLength || text.length > 12000) throw new Error(`Pinned corpus ${source.id} invalid; no silent truncation or replacement`);
    corpus.set(source.id, text);
  }
  return corpus;
}

async function runEvaluation() {
  const manifest = JSON.parse(await readFile(path.join(evaluationDir, 'manifest.json'), 'utf8'));
  const questions = JSON.parse(await readFile(path.join(evaluationDir, 'questions.json'), 'utf8'));
  const corpus = await loadCorpus(manifest, process.argv.includes('--fetch'));
  for (const question of questions) for (const span of question.evidence || []) validateAnnotation(corpus.get(span.sourceId), span);
  await mkdir(outputDir, { recursive: true });
  for (const [file, original] of [['baseline-library.mjs', 'src/library.mjs'], ['baseline-core.mjs', 'web/core.mjs']]) {
    let code = execFileSync('git', ['show', `${manifest.baselineCommit}:${original}`], { cwd: root, encoding: 'utf8' });
    if (original === 'src/library.mjs') code = code.replace("'../web/core.mjs'", "'./baseline-core.mjs'");
    await writeFile(path.join(outputDir, file), code, 'utf8');
  }
  const baseline = await import(pathToFileURL(path.join(outputDir, 'baseline-library.mjs')));
  const current = await import(pathToFileURL(path.join(root, 'src/library.mjs')));
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'retrieval-fixed-eval-'));
  const reports = {};
  try {
    for (const [name, module] of [['baseline', baseline], ['current', current]]) {
      const filePath = path.join(temporary, `${name}.json`);
      const library = new module.LibraryStore({ filePath });
      const idMap = new Map();
      for (const entry of manifest.sources) {
        const task = { id: `eval-${entry.id}`, company: entry.company, start: '2025-01-01', end: '2025-12-31', topic: 'fixed public disclosure retrieval evaluation' };
        const source = { id: entry.id, title: entry.title, publisher: entry.publisher, url: entry.url, date: entry.date, text: corpus.get(entry.id), collectedAt: '2026-10-30T00:00:00.000Z', review: 'included', access: 'available', flagged: false, demo: false, note: '' };
        const saved = await library.save({ task, source });
        idMap.set(saved.document.id, entry.id);
      }
      // Identical fixed ordering metadata in both isolated stores; no production data touched.
      const store = JSON.parse(await readFile(filePath, 'utf8'));
      for (const doc of store.documents) doc.createdAt = doc.updatedAt = `${doc.source.date}T00:00:00.000Z`;
      await writeFile(filePath, JSON.stringify(store), 'utf8');
      const rows = [];
      let searchMs = 0;
      for (const question of questions) {
        const started = performance.now();
        const result = await library.search({ company: question.company, query: question.query, limit: 5 });
        const elapsedMs = performance.now() - started;
        searchMs += elapsedMs;
        for (const hit of result.results) {
          const original = corpus.get(idMap.get(hit.documentId));
          if (!original || original.slice(hit.chunk.start, hit.chunk.end) !== hit.chunk.text) throw new Error('Returned chunk differs from fixed original');
          if (name === 'current' && (!hit.preview || hit.preview.text.length > 480 || hit.preview.text.length !== hit.preview.end - hit.preview.start || original.slice(hit.preview.start, hit.preview.end) !== hit.preview.text || hit.preview.start < hit.chunk.start || hit.preview.end > hit.chunk.end)) throw new Error('Returned preview is not an exact bounded original substring');
        }
        rows.push({ ...scoreQuestion(question, result.results, idMap, name), elapsedMs });
      }
      reports[name] = { aggregate: aggregate(rows), sameLanguage: aggregate(rows.filter(row => row.category !== 'cross-language')), searchMs, questions: rows };
    }
  } finally {
    if (path.dirname(temporary) !== os.tmpdir()) throw new Error('Refusing unsafe temporary cleanup');
    await rm(temporary, { recursive: true, force: true });
  }
  const report = { schemaVersion: 2, date: '2026-10-30', baselineCommit: manifest.baselineCommit, manifestSha256: sha256(JSON.stringify(manifest)), questionsSha256: sha256(JSON.stringify(questions)), sourceCount: manifest.sources.length, companies: [...new Set(manifest.sources.map(source => source.company))], implementation: 'actual LibraryStore.search; fixed source metadata; no model calls', currentCodeSha256: Object.fromEntries(await Promise.all(['src/library.mjs', 'web/core.mjs', 'web/retrieval.mjs'].map(async file => [file, sha256(await readFile(path.join(root, file)))]))), ...reports };
  await writeFile(path.join(outputDir, 'evaluation.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify({ baseline: reports.baseline.aggregate, current: reports.current.aggregate, searchMs: { baseline: reports.baseline.searchMs, current: reports.current.searchMs }, report: 'outputs/v0.5.1-eval/evaluation.json' }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) runEvaluation().catch(error => { console.error(`Evaluation failed: ${error.message}`); process.exitCode = 1; });
