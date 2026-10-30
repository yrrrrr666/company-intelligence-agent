import { MAX_TEXT, validateSources } from './core.mjs';

// The server resolves the current active version immediately before this conversion.
// Imported evidence is a new task snapshot and must be reviewed again.
export function libraryResultSource(result, query) {
  const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
  if (!result || !identifier(result.documentId) || !Number.isSafeInteger(result.version) || result.version < 1 || typeof result.company !== 'string' || !result.company.trim() || result.company.length > 100 || typeof query !== 'string' || !query.trim() || query.length > 200) throw new Error('资料库检索记录无效，请重新检索');
  validateSources([result.source]);
  const original = result.source;
  const chunk = result.chunk;
  if (original.review !== 'included' || original.access !== 'available' || original.demo || original.library || !original.text.trim() || !chunk || !identifier(chunk.id) || !Number.isSafeInteger(chunk.start) || !Number.isSafeInteger(chunk.end) || chunk.start < 0 || chunk.end <= chunk.start || chunk.end > original.text.length || typeof chunk.text !== 'string' || !chunk.text.trim() || chunk.text.length > MAX_TEXT || original.text.slice(chunk.start, chunk.end) !== chunk.text || !Array.isArray(result.issues) || result.issues.length > 20 || result.issues.some(issue => typeof issue !== 'string' || !issue.trim() || issue.length > 200)) throw new Error('资料库片段与保存正文不一致，请重新检索');
  let context = chunk;
  if (result.preview !== undefined) {
    const preview = result.preview;
    if (!preview || !Number.isSafeInteger(preview.start) || !Number.isSafeInteger(preview.end) || preview.start < chunk.start || preview.end > chunk.end || preview.end <= preview.start || typeof preview.text !== 'string' || !preview.text.trim() || preview.text.length > 480 || preview.text.length !== preview.end - preview.start || original.text.slice(preview.start, preview.end) !== preview.text || !Array.isArray(preview.matchRanges) || preview.matchRanges.length > 200) throw new Error('匹配上下文与保存正文不一致，请重新检索');
    let previousEnd = preview.start;
    for (const range of preview.matchRanges) {
      if (!range || !Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end) || range.start < previousEnd || range.end <= range.start || range.end > preview.end) throw new Error('匹配位置记录无效，请重新检索');
      previousEnd = range.end;
    }
    context = preview;
  }
  const source = {
    ...structuredClone(original),
    id: crypto.randomUUID(),
    text: context.text,
    review: 'pending',
    flagged: original.flagged || result.issues.length > 0,
    library: {
      documentId: result.documentId,
      version: result.version,
      chunkId: chunk.id,
      start: context.start,
      end: context.end,
      originalLength: original.text.length,
      retrievedAt: new Date().toISOString(),
      query: query.trim(),
      company: result.company,
      archivedIssues: [...result.issues]
    }
  };
  validateSources([source]);
  return source;
}
