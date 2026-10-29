import { MAX_SOURCES, MAX_TEXT, normalizeUrl, publicWebUrl, validateSources } from './core.mjs';

export function mergeSearchCandidates(sources, candidates, query = '') {
  const known = new Set(sources.map(source => normalizeUrl(source.url)).filter(Boolean));
  const added = [];
  let duplicates = 0;
  let omitted = 0;
  for (const candidate of candidates) {
    const url = publicWebUrl(candidate.url);
    if (!url) { omitted++; continue; }
    const normalized = normalizeUrl(url);
    if (known.has(normalized)) { duplicates++; continue; }
    if (sources.length + added.length >= MAX_SOURCES) { omitted++; continue; }
    const source = {
      id: crypto.randomUUID(), title: candidate.title || new URL(url).hostname,
      url, publisher: candidate.publisher || new URL(url).hostname, date: candidate.date || '',
      text: '', collectedAt: new Date().toISOString(), review: 'pending', flagged: false, demo: false, access: 'failed', note: '',
      web: { provider: 'deepseek', status: 'pending', dateOrigin: candidate.date ? 'search' : 'unknown', query, snippet: candidate.snippet || '', error: '', fetchedAt: '', truncated: false, originalChars: 0 }
    };
    validateSources([source]);
    known.add(normalized);
    added.push(source);
  }
  return { sources: [...sources, ...added], added, duplicates, omitted };
}

export function saveWebText(source, result) {
  const next = { ...source, title: result.title || source.title, text: result.text, access: 'available', review: source.review === 'included' ? 'pending' : source.review, web: { ...source.web, status: 'available', fetchedAt: result.fetchedAt, truncated: result.truncated, originalChars: result.originalChars, error: '' } };
  if (typeof next.text !== 'string' || !next.text.trim() || next.text.length > MAX_TEXT) throw new Error('正文响应无效，请重试。');
  validateSources([next]);
  return next;
}
