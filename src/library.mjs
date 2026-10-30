import { readFile, mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { validateTask, validateSources, sourceIssues, normalizeUrl, isDate } from '../web/core.mjs';

const MAX_DOCUMENTS = 200;
const MAX_REVISIONS = 20;
const MAX_BYTES = 32 * 1024 * 1024;
const queues = new Map();
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const sourceFields = ['id', 'title', 'url', 'publisher', 'date', 'text', 'collectedAt', 'review', 'flagged', 'access', 'demo', 'note'];
const fileFields = ['kind', 'name', 'size', 'sha256', 'extractedChars', 'truncated', 'totalPages', 'pageStart', 'pageEnd'];
const webFields = ['provider', 'status', 'query', 'snippet', 'error', 'truncated', 'originalChars', 'fetchedAt', 'dateOrigin'];
const pick = (input, fields) => Object.fromEntries(fields.filter(key => Object.hasOwn(input, key)).map(key => [key, input[key]]));
const clone = value => structuredClone(value);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export class LibraryError extends Error {
  constructor(message, status = 400, code = 'LIBRARY_INVALID_INPUT') { super(message); this.status = status; this.code = code; }
}

function invalid(message = '资料库请求无效，请检查后重试。') { throw new LibraryError(message); }
function companyKey(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 100) invalid('请填写不超过 100 字的公司名称。');
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
}
function checkedQuery(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 200) invalid('检索词须为 1–200 个字符。');
  return value.trim();
}
function checkedId(id) { if (typeof id !== 'string' || !UUID.test(id)) invalid('资料库编号无效。'); }
function checkedVersion(version) { if (!Number.isSafeInteger(version) || version < 1 || version > MAX_REVISIONS) invalid('资料版本无效。'); }
function sanitize(task, source) {
  if (Object.keys(validateTask(task || {})).length) invalid('研究范围无效，请先创建研究任务。');
  try { validateSources([source]); } catch { invalid('资料格式无效，请先核查资料。'); }
  if (task.demo || source.demo) invalid('虚构演示资料不能存入正式资料库。');
  if (source.library) invalid('检索片段不能再次入库，请保存原始资料。');
  if (source.review !== 'included' || source.access !== 'available' || !source.text.trim()) invalid('请先审核并纳入有正文的资料，再保存到资料库。');
  if (source.url.length > 2048 || source.collectedAt.length > 40) invalid('资料元数据超出长度限制。');
  const snapshot = pick(source, sourceFields);
  if (source.file) snapshot.file = pick(source.file, fileFields);
  if (source.web) snapshot.web = pick(source.web, webFields);
  const scope = pick(task, ['company', 'start', 'end', 'topic']);
  scope.company = scope.company.trim();
  if (typeof task.id === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(task.id)) scope.id = task.id;
  return { task: scope, source: snapshot };
}
function identityFor(task, source) {
  const identity = source.file ? ['file', source.file.sha256, source.file.pageStart ?? null, source.file.pageEnd ?? null] : source.url ? ['url', normalizeUrl(source.url)] : ['manual', source.id];
  return hash([companyKey(task.company), identity]);
}
function contentHash(source) {
  const value = clone(source);
  value.url = normalizeUrl(value.url) || '';
  delete value.id;
  delete value.collectedAt;
  // Collection queries and timestamps do not change the saved evidence or review decision.
  if (value.web) { delete value.web.query; delete value.web.fetchedAt; delete value.web.snippet; }
  return hash(value);
}
function publicDocument(document) { return clone(pick(document, ['id', 'company', 'status', 'version', 'createdAt', 'updatedAt', 'task', 'source', 'issues'])); }

// Offsets use JavaScript UTF-16 indices; every result is an exact slice of saved text.
export function splitLibraryText(text) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + 900, text.length);
    if (end < text.length) {
      const candidate = text.slice(start + 450, end);
      const breaks = [...candidate.matchAll(/[。！？!?；;\n]/g)];
      if (breaks.length) end = start + 450 + breaks.at(-1).index + 1;
      // Do not split UTF-16 surrogate pairs.
      if (/[\uD800-\uDBFF]/.test(text[end - 1]) && /[\uDC00-\uDFFF]/.test(text[end])) end--;
    }
    chunks.push({ id: `chunk-${chunks.length + 1}`, start, end, text: text.slice(start, end) });
    if (end === text.length) break;
    start = Math.max(start + 1, end - 100);
    if (/[\uDC00-\uDFFF]/.test(text[start]) && /[\uD800-\uDBFF]/.test(text[start - 1])) start++;
  }
  return chunks;
}

function tokens(value) {
  const normalized = value.normalize('NFKC').toLocaleLowerCase('zh-CN');
  const result = new Set(normalized.match(/[a-z0-9]+/g) || []);
  for (const run of normalized.match(/[\p{Script=Han}]+/gu) || []) {
    const chars = [...run];
    if (chars.length === 1) result.add(chars[0]);
    else for (let i = 0; i < chars.length - 1; i++) result.add(chars[i] + chars[i + 1]);
  }
  return [...result];
}
function scoreText(text, queryTokens) {
  const value = text.normalize('NFKC').toLocaleLowerCase('zh-CN');
  return queryTokens.reduce((score, token) => score + (value.includes(token) ? 1 : 0), 0);
}
function resultFor(document, chunk) {
  return { documentId: document.id, version: document.version, company: document.company, title: document.source.title, publisher: document.source.publisher, date: document.source.date, flagged: document.source.flagged, issues: clone(document.issues), chunk: clone(chunk), source: clone(document.source), archivedAt: document.updatedAt };
}

function validateStore(store) {
  if (!store || store.schemaVersion !== 1 || !Array.isArray(store.documents) || store.documents.length > MAX_DOCUMENTS) throw new Error('invalid store');
  const ids = new Set();
  for (const doc of store.documents) {
    checkedId(doc.id);
    checkedVersion(doc.version);
    if (ids.has(doc.id) || !['active', 'withdrawn'].includes(doc.status) || typeof doc.identity !== 'string' || !/^[a-f0-9]{64}$/.test(doc.identity) || !Array.isArray(doc.revisions) || doc.revisions.length !== doc.version - 1 || !Array.isArray(doc.issues) || doc.issues.some(issue => typeof issue !== 'string' || issue.length > 200) || !isDate(doc.createdAt?.slice(0, 10)) || !isDate(doc.updatedAt?.slice(0, 10))) throw new Error('invalid document');
    ids.add(doc.id);
    const sanitized = sanitize(doc.task, doc.source);
    if (companyKey(doc.company) !== companyKey(doc.task.company) || doc.identity !== identityFor(sanitized.task, sanitized.source) || !isDeepStrictEqual(doc.source, sanitized.source) || !isDeepStrictEqual(doc.task, sanitized.task) || !isDeepStrictEqual(doc.issues, sourceIssues(doc.source, doc.task, [doc.source]))) throw new Error('invalid document');
    for (let i = 0; i < doc.revisions.length; i++) {
      const rev = doc.revisions[i];
      if (rev.version !== i + 1 || !isDate(rev.updatedAt?.slice(0, 10)) || !['active', 'withdrawn'].includes(rev.status)) throw new Error('invalid revision');
      const previous = sanitize(rev.task, rev.source);
      if (identityFor(previous.task, previous.source) !== doc.identity || !isDeepStrictEqual(rev.source, previous.source) || !isDeepStrictEqual(rev.task, previous.task) || !isDeepStrictEqual(rev.issues, sourceIssues(rev.source, rev.task, [rev.source]))) throw new Error('invalid revision');
    }
  }
  return store;
}

export class LibraryStore {
  constructor({ filePath }) { this.filePath = path.resolve(filePath); }
  async run(action) {
    const previous = queues.get(this.filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(this.filePath, current);
    try { return await current; }
    finally { if (queues.get(this.filePath) === current) queues.delete(this.filePath); }
  }
  async load() {
    try {
      if ((await stat(this.filePath)).size > MAX_BYTES) throw new Error('store too large');
      return validateStore(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, documents: [] };
      throw new LibraryError('无法读取资料库，原文件未被修改。请检查资料库文件或恢复备份。', 503, 'LIBRARY_UNAVAILABLE');
    }
  }
  async write(store) {
    const text = JSON.stringify(store);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new LibraryError('资料库已达到容量上限，请先备份并整理资料。', 409, 'LIBRARY_CAPACITY');
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let file;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(text, 'utf8');
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, this.filePath);
    } catch {
      throw new LibraryError('资料库保存失败，原有资料仍保留，请检查磁盘后重试。', 503, 'LIBRARY_WRITE_FAILED');
    } finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async save(input) {
    const snapshot = sanitize(input?.task, input?.source);
    return this.run(async () => {
      const store = await this.load();
      const identity = identityFor(snapshot.task, snapshot.source);
      const existing = store.documents.find(doc => doc.identity === identity);
      const issues = sourceIssues(snapshot.source, snapshot.task, [snapshot.source]);
      if (existing?.status === 'active' && contentHash(existing.source) === contentHash(snapshot.source) && isDeepStrictEqual(existing.issues, issues)) return { document: publicDocument(existing), duplicate: true };
      if (!existing && store.documents.length >= MAX_DOCUMENTS) throw new LibraryError('资料库最多保存 200 份资料，请先整理资料。', 409, 'LIBRARY_CAPACITY');
      if (existing?.version >= MAX_REVISIONS) throw new LibraryError('该资料已达到 20 个版本上限，请先备份整理。', 409, 'LIBRARY_CAPACITY');
      const now = new Date().toISOString();
      const document = { id: existing?.id || randomUUID(), identity, company: snapshot.task.company, status: 'active', version: (existing?.version || 0) + 1, createdAt: existing?.createdAt || now, updatedAt: now, ...snapshot, issues, revisions: existing ? [...existing.revisions, pick(existing, ['version', 'updatedAt', 'task', 'source', 'issues', 'status'])] : [] };
      if (existing) store.documents[store.documents.indexOf(existing)] = document;
      else store.documents.push(document);
      await this.write(store);
      return { document: publicDocument(document), duplicate: false };
    });
  }
  async list({ company } = {}) {
    const key = company === undefined || company === '' ? null : companyKey(company);
    return this.run(async () => {
      const store = await this.load();
      const documents = store.documents.filter(doc => !key || companyKey(doc.company) === key).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(publicDocument);
      return { documents, total: documents.length };
    });
  }
  async get(id) {
    checkedId(id);
    return this.run(async () => {
      const document = (await this.load()).documents.find(doc => doc.id === id);
      if (!document) throw new LibraryError('资料不存在。', 404, 'LIBRARY_NOT_FOUND');
      return { document: publicDocument(document) };
    });
  }
  async withdraw(id, { version } = {}) {
    checkedId(id); checkedVersion(version);
    return this.run(async () => {
      const store = await this.load();
      const document = store.documents.find(doc => doc.id === id);
      if (!document) throw new LibraryError('资料不存在。', 404, 'LIBRARY_NOT_FOUND');
      if (document.version !== version) throw new LibraryError('资料版本已更新，请刷新后重试。', 409, 'LIBRARY_STALE_VERSION');
      if (document.status !== 'withdrawn') { document.status = 'withdrawn'; document.updatedAt = new Date().toISOString(); await this.write(store); }
      return { document: publicDocument(document) };
    });
  }
  async search(input) {
    const key = companyKey(input?.company);
    const query = checkedQuery(input?.query);
    const limit = input.limit ?? 8;
    if (!Number.isInteger(limit) || limit < 1 || limit > 8 || (input.includeFlagged !== undefined && typeof input.includeFlagged !== 'boolean')) invalid();
    for (const field of ['start', 'end']) if (input[field] !== undefined && input[field] !== '' && !isDate(input[field])) invalid('发布日期筛选无效。');
    if (input.start && input.end && input.start > input.end) invalid('结束日期不能早于起始日期。');
    const terms = tokens(query);
    return this.run(async () => {
      const store = await this.load();
      const scored = [];
      for (const doc of store.documents) {
        if (doc.status !== 'active' || companyKey(doc.company) !== key || (!input.includeFlagged && (doc.source.flagged || doc.issues.length))) continue;
        if ((input.start || input.end) && (!doc.source.date || (input.start && doc.source.date < input.start) || (input.end && doc.source.date > input.end))) continue;
        for (const chunk of splitLibraryText(doc.source.text)) {
          // Body must match; a title-only match must not inject unrelated chunks.
          const bodyScore = scoreText(chunk.text, terms);
          if (!bodyScore) continue;
          const score = bodyScore * 3 + scoreText(doc.source.title, terms);
          scored.push({ score, document: doc, chunk });
        }
      }
      scored.sort((a, b) => b.score - a.score || b.document.updatedAt.localeCompare(a.document.updatedAt) || a.chunk.start - b.chunk.start);
      // First return the strongest chunk of each document, then remaining chunks.
      const seen = new Set(); const first = []; const remaining = [];
      for (const item of scored) { if (seen.has(item.document.id)) remaining.push(item); else { seen.add(item.document.id); first.push(item); } }
      return { results: [...first, ...remaining].slice(0, limit).map(item => resultFor(item.document, item.chunk)), total: scored.length, mode: 'keyword' };
    });
  }
  async retrieve(input) {
    checkedId(input?.documentId); checkedVersion(input?.version); checkedQuery(input?.query);
    if (typeof input.chunkId !== 'string' || !/^chunk-[1-9]\d{0,2}$/.test(input.chunkId)) invalid('检索片段编号无效。');
    return this.run(async () => {
      const doc = (await this.load()).documents.find(item => item.id === input.documentId);
      if (!doc) throw new LibraryError('资料不存在。', 404, 'LIBRARY_NOT_FOUND');
      if (doc.status !== 'active' || doc.version !== input.version) throw new LibraryError('资料已撤回或更新，请重新检索后再使用。', 409, 'LIBRARY_STALE_VERSION');
      const chunk = splitLibraryText(doc.source.text).find(item => item.id === input.chunkId);
      if (!chunk) throw new LibraryError('检索片段不存在，请重新检索。', 404, 'LIBRARY_NOT_FOUND');
      return { result: resultFor(doc, chunk) };
    });
  }
}
