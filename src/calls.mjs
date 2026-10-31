import { readFile, mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const MAX_BYTES = 2 * 1024 * 1024;
const queues = new Map();
const statuses = new Set(['running', 'succeeded', 'failed', 'cancelled', 'interrupted']);
const operations = new Set(['search', 'read', 'report']);
const tokenFields = { inputTokens: 'prompt_tokens', outputTokens: 'completion_tokens', totalTokens: 'total_tokens', cacheHitInputTokens: 'prompt_cache_hit_tokens', cacheMissInputTokens: 'prompt_cache_miss_tokens' };
const identifier = (value, limit = 80) => typeof value === 'string' && value.length <= limit && /^[A-Za-z0-9_-]+$/.test(value) ? value : null;
const modelName = value => typeof value === 'string' && /^[A-Za-z0-9._:/-]{1,100}$/.test(value) ? value : null;
const timestamp = value => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value));
const nullable = (value, check) => value === null || check(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const publicRecord = record => {
  const { sessionId, ...result } = record;
  return structuredClone(result);
};

export function normalizeUsage(usage) {
  return Object.fromEntries(Object.entries(tokenFields).map(([field, key]) => [field, count(usage?.[key]) ? usage[key] : null]));
}

export class CallLogError extends Error {
  constructor() { super('调用记录暂时不可用，请检查本地记录文件或恢复备份后重试。'); }
}

function validateStore(store) {
  if (!store || store.schemaVersion !== 1 || !Array.isArray(store.records) || store.records.length > 500) throw new CallLogError();
  const seen = new Set();
  for (const record of store.records) {
    if (!record || !/^[a-f0-9-]{36}$/.test(record.id) || seen.has(record.id) || !identifier(record.sessionId) || !operations.has(record.operation) || !statuses.has(record.status) || !timestamp(record.startedAt) || !nullable(record.finishedAt, timestamp) || !nullable(record.durationMs, count) || !nullable(record.taskId, identifier) || !nullable(record.sourceId, identifier) || !nullable(record.model, modelName) || !nullable(record.providerRequestId, value => identifier(value, 120)) || !nullable(record.httpStatus, value => Number.isInteger(value) && value >= 100 && value <= 599) || !nullable(record.errorCode, value => typeof value === 'string' && /^[A-Z0-9_]{1,80}$/.test(value)) || record.cost !== null || !record.usage || Object.keys(tokenFields).some(field => !nullable(record.usage[field], count))) throw new CallLogError();
    if ((record.status === 'running') !== (record.finishedAt === null) || (record.status === 'running' && record.durationMs !== null)) throw new CallLogError();
    // Reject extra data rather than accidentally exposing arbitrary disk contents.
    if (Object.keys(record).sort().join() !== 'cost,durationMs,errorCode,finishedAt,httpStatus,id,model,operation,providerRequestId,sessionId,sourceId,startedAt,status,taskId,usage' || Object.keys(record.usage).sort().join() !== Object.keys(tokenFields).sort().join()) throw new CallLogError();
    seen.add(record.id);
  }
  return store;
}

export class CallLog {
  constructor({ filePath, maxRecords = 500 }) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1 || maxRecords > 500) throw new CallLogError();
    this.filePath = path.resolve(filePath);
    this.maxRecords = maxRecords;
    this.sessionId = randomUUID();
  }
  async run(action) {
    const previous = queues.get(this.filePath) || Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    queues.set(this.filePath, current);
    try { return await current; }
    finally { if (queues.get(this.filePath) === current) queues.delete(this.filePath); }
  }
  async load() {
    let store;
    try {
      if ((await stat(this.filePath)).size > MAX_BYTES) throw new CallLogError();
      store = validateStore(JSON.parse(await readFile(this.filePath, 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return { schemaVersion: 1, records: [] };
      throw new CallLogError();
    }
    let recovered = false;
    for (const record of store.records) {
      if (record.status === 'running' && record.sessionId !== this.sessionId) {
        Object.assign(record, { status: 'interrupted', finishedAt: new Date().toISOString(), durationMs: null, errorCode: 'SERVICE_RESTARTED' });
        recovered = true;
      }
    }
    if (recovered) await this.write(store);
    return store;
  }
  async write(store) {
    const text = JSON.stringify(store);
    if (Buffer.byteLength(text) > MAX_BYTES) throw new CallLogError();
    const temporary = `${this.filePath}.${randomUUID()}.tmp`;
    let file;
    try {
      await mkdir(path.dirname(this.filePath), { recursive: true });
      file = await open(temporary, 'wx', 0o600);
      await file.writeFile(text, 'utf8');
      await file.sync();
      await file.close(); file = null;
      await rename(temporary, this.filePath);
    } catch { throw new CallLogError(); }
    finally {
      if (file) await file.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  async start({ operation, taskId, sourceId, model }) {
    if (!operations.has(operation)) throw new CallLogError();
    const record = { id: randomUUID(), sessionId: this.sessionId, operation, taskId: identifier(taskId), sourceId: identifier(sourceId), model: modelName(model), status: 'running', startedAt: new Date().toISOString(), finishedAt: null, durationMs: null, httpStatus: null, providerRequestId: null, usage: normalizeUsage(null), cost: null, errorCode: null };
    const started = performance.now();
    await this.run(async () => {
      const store = await this.load();
      store.records.push(record);
      while (store.records.length > this.maxRecords) {
        const oldest = store.records.findIndex(item => item.status !== 'running');
        if (oldest < 0) throw new CallLogError();
        store.records.splice(oldest, 1);
      }
      await this.write(store);
    });
    const metadata = {};
    let completion;
    return {
      id: record.id,
      onResponse: response => { metadata.httpStatus = response.status; metadata.providerRequestId = identifier(response.headers.get('x-request-id'), 120); },
      onUsage: (usage, payload) => {
        metadata.usage = normalizeUsage(usage);
        metadata.providerRequestId ||= identifier(payload?.id, 120);
        metadata.model = modelName(payload?.model) || record.model;
      },
      finish: ({ status, errorCode = null }) => {
        if (!['succeeded', 'failed', 'cancelled'].includes(status) || !nullable(errorCode, value => /^[A-Z0-9_]{1,80}$/.test(value))) throw new CallLogError();
        completion ||= this.run(async () => {
          const store = await this.load();
          const saved = store.records.find(item => item.id === record.id);
          if (!saved || saved.status !== 'running') throw new CallLogError();
          Object.assign(saved, metadata, { status, errorCode, finishedAt: new Date().toISOString(), durationMs: Math.max(0, Math.round(performance.now() - started)) });
          await this.write(store);
        });
        return completion;
      }
    };
  }
  async list({ taskId } = {}) {
    if (taskId !== undefined && !identifier(taskId)) throw new CallLogError();
    return this.run(async () => {
      const store = await this.load();
      const records = store.records.filter(item => taskId === undefined || item.taskId === taskId).reverse().map(publicRecord);
      return { records, retained: store.records.length, limit: this.maxRecords };
    });
  }
}
