// Deterministic lexical matching only: no embedding, model, aliases or learned ranker.
// All returned offsets address the original string in JavaScript UTF-16 units.
const graphemes = new Intl.Segmenter('und', { granularity: 'grapheme' });
const stopPairs = new Set(['什么', '多少', '如何', '怎样', '哪些', '是否', '请问', '以及', '关于', '分别']);
const queryCache = new Map();

function normalized(value, positions = false) {
  const canonical = value.normalize('NFKC');
  const folded = canonical.toLowerCase();
  if (!positions) return { text: folded, starts: [], ends: [] };
  // Most saved prose is already canonical. Its length-preserving case fold maps
  // directly, avoiding grapheme segmentation for every chunk in a large library.
  if (canonical === value && folded.length === value.length) return { text: folded, starts: Array.from({ length: value.length }, (_, index) => index), ends: Array.from({ length: value.length }, (_, index) => index + 1) };
  let text = '';
  const starts = [];
  const ends = [];
  for (const { segment, index } of graphemes.segment(value)) {
    const part = segment.normalize('NFKC').toLowerCase();
    text += part;
    if (positions) for (let unit = 0; unit < part.length; unit++) { starts.push(index); ends.push(index + segment.length); }
  }
  return { text, starts, ends };
}

function queryParts(query) {
  if (queryCache.has(query)) return queryCache.get(query);
  const value = normalized(query).text;
  const framed = value.replace(/(?:请问|是多少|是什么|有多少|多少|如何|怎样|哪些|是否)/gu, ' ');
  const terms = new Map();
  const phrases = [];
  for (const match of framed.matchAll(/[\p{Script=Han}]+|[a-z]+[a-z0-9]*|\d+(?:[.,]\d+)*[a-z0-9]*/gu)) {
    const word = match[0];
    if (/\p{Script=Han}/u.test(word)) {
      // Grammatical connectors should not make a document relevant by themselves.
      for (const run of word.split(/[的了呢吗与和及]/u).filter(Boolean)) {
        const chars = [...run];
        if (chars.length === 1) {
          if (!/[是有在到为于年]/u.test(run)) terms.set(run, { text: run, weight: 1, latin: false });
        } else {
          if (chars.length >= 3) phrases.push(run);
          for (let index = 0; index < chars.length - 1; index++) {
            const pair = chars[index] + chars[index + 1];
            if (!stopPairs.has(pair)) terms.set(pair, { text: pair, weight: 2, latin: false });
          }
        }
      }
    } else terms.set(word, { text: word, weight: /^\d/.test(word) ? 1 : 3, latin: true });
  }
  const result = { terms: [...terms.values()], phrases };
  if (queryCache.size >= 32) queryCache.delete(queryCache.keys().next().value);
  queryCache.set(query, result);
  return result;
}

function occurrences(text, needle, boundary = false) {
  const ranges = [];
  let cursor = 0;
  while (cursor <= text.length - needle.length) {
    const start = text.indexOf(needle, cursor);
    if (start === -1) break;
    const end = start + needle.length;
    if (!boundary || (!/[a-z0-9_]/.test(text[start - 1] || '') && !/[a-z0-9_]/.test(text[end] || ''))) ranges.push({ start, end });
    cursor = start + Math.max(1, needle.length);
  }
  return ranges;
}

function mergeRanges(ranges) {
  const merged = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

export function lexicalMatch(text, query) {
  const indexed = normalized(text, true);
  const { terms, phrases } = queryParts(query);
  const totalWeight = terms.reduce((sum, term) => sum + term.weight, 0);
  let matchedWeight = 0;
  const hits = [];
  for (const term of terms) {
    const matches = occurrences(indexed.text, term.text, term.latin);
    if (matches.length) { matchedWeight += term.weight; hits.push(...matches); }
  }
  if (!matchedWeight) return { score: 0, ranges: [], coverage: 0 };
  const phraseHits = phrases.flatMap(phrase => occurrences(indexed.text, phrase));
  const coverage = matchedWeight / totalWeight;
  const strongestPhrase = phraseHits.reduce((max, hit) => Math.max(max, hit.end - hit.start), 0);
  const ranges = mergeRanges([...hits, ...phraseHits].map(range => ({ start: indexed.starts[range.start], end: indexed.ends[range.end - 1] })));
  // Repetition cannot inflate term coverage; compact matches beat scattered background.
  let compactness = 0;
  let right = 0;
  let sum = 0;
  for (let left = 0; left < ranges.length; left++) {
    const anchor = ranges[left];
    if (right < left) { right = left; sum = 0; }
    while (right < ranges.length && ranges[right].end <= anchor.start + 120) { sum += ranges[right].end - ranges[right].start; right++; }
    const covered = right > left ? sum : Math.min(120, anchor.end - anchor.start);
    const span = right > left ? ranges[right - 1].end - anchor.start : Math.min(120, anchor.end - anchor.start);
    compactness = Math.max(compactness, Math.min(8, covered / Math.max(8, span) * 8));
    if (right > left) sum -= anchor.end - anchor.start;
  }
  const score = 24 * coverage * coverage + 3 * matchedWeight + Math.min(16, strongestPhrase * 2) + compactness;
  return { score, ranges, coverage };
}

function safeStart(text, index) { return /[\uDC00-\uDFFF]/.test(text[index] || '') && /[\uD800-\uDBFF]/.test(text[index - 1] || '') ? index - 1 : index; }
function safeEnd(text, index) { return /[\uD800-\uDBFF]/.test(text[index - 1] || '') && /[\uDC00-\uDFFF]/.test(text[index] || '') ? index - 1 : index; }
const sentenceEnd = /[。！？!?\n]/u;

export function retrievalPreview(text, query, { offset = 0, maxLength = 480 } = {}) {
  if (typeof text !== 'string' || typeof query !== 'string' || !Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(maxLength) || maxLength < 32 || maxLength > 480) throw new Error('Invalid retrieval preview input');
  const { ranges } = lexicalMatch(text, query);
  let start = 0;
  let end = Math.min(text.length, maxLength);
  if (ranges.length && text.length > maxLength) {
    let best = -1;
    const anchorIndexes = new Set([0]);
    if (queryParts(query).terms.length > 1) {
      // Bound work even for thousands of repeated matches in legacy task snapshots.
      const strongest = ranges.map((range, index) => ({ index, length: range.end - range.start })).sort((a, b) => b.length - a.length || a.index - b.index).slice(0, 6);
      for (const anchor of strongest) anchorIndexes.add(anchor.index);
      for (let index = 0; index < 6; index++) anchorIndexes.add(Math.round(index * (ranges.length - 1) / 5));
    }
    const seenStarts = new Set();
    // Score bounded contexts by unique query coverage, never by repeated hit count.
    for (const index of anchorIndexes) {
      const anchor = ranges[index];
      let candidateStart = Math.max(0, anchor.start - Math.floor(maxLength * .4));
      let preceding = anchor.start;
      while (preceding > candidateStart && !sentenceEnd.test(text[preceding - 1])) preceding--;
      if (preceding > candidateStart || candidateStart === 0) {
        candidateStart = preceding;
        // Keep a preceding short heading/sentence, including quarter and unit labels.
        let previousEnd = candidateStart;
        while (previousEnd > 0 && /\s/u.test(text[previousEnd - 1])) previousEnd--;
        let previousStart = previousEnd > 0 ? previousEnd - 1 : 0;
        while (previousStart > 0 && !sentenceEnd.test(text[previousStart - 1])) previousStart--;
        if (anchor.start - previousStart <= 120) candidateStart = previousStart;
      }
      candidateStart = safeStart(text, candidateStart);
      if (seenStarts.has(candidateStart)) continue;
      seenStarts.add(candidateStart);
      let candidateEnd = safeEnd(text, Math.min(text.length, candidateStart + maxLength));
      let boundary = candidateEnd;
      while (boundary > anchor.end && !sentenceEnd.test(text[boundary - 1])) boundary--;
      if (boundary > anchor.end) candidateEnd = boundary;
      const candidateText = text.slice(candidateStart, candidateEnd);
      const value = lexicalMatch(candidateText, query).score + lexicalMatch(candidateText.slice(0, 180), query).score * .15;
      if (value > best) { best = value; start = candidateStart; end = candidateEnd; }
    }
  }
  start = safeStart(text, start);
  end = safeEnd(text, end);
  if (end - start > maxLength) end = safeEnd(text, start + maxLength);
  const matchRanges = ranges.filter(range => range.end > start && range.start < end).slice(0, 200).map(range => ({ start: Math.max(start, range.start) + offset, end: Math.min(end, range.end) + offset }));
  return { text: text.slice(start, end), start: start + offset, end: end + offset, matchRanges };
}
