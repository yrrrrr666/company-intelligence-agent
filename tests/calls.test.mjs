import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CallLog, normalizeUsage } from '../src/calls.mjs';

async function fixture(t, options = {}) {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'company-call-log-'));
  t.after(async () => { assert.equal(path.dirname(dir), os.tmpdir()); await rm(dir, { recursive: true, force: true }); });
  const filePath = path.join(dir, 'calls.json');
  return { dir, filePath, log: new CallLog({ filePath, ...options }) };
}

test('usage keeps provider-reported zeroes and leaves missing or invalid fields unknown', () => {
  assert.deepEqual(normalizeUsage({ prompt_tokens: 0, completion_tokens: 3, total_tokens: 3, prompt_cache_hit_tokens: 0, prompt_cache_miss_tokens: 0 }), { inputTokens: 0, outputTokens: 3, totalTokens: 3, cacheHitInputTokens: 0, cacheMissInputTokens: 0 });
  const usage = normalizeUsage({ prompt_tokens: '12', completion_tokens: -1, total_tokens: Infinity, prompt_cache_hit_tokens: 0 });
  assert.equal(usage.inputTokens, null);
  assert.equal(usage.outputTokens, null);
  assert.equal(usage.totalTokens, null);
  assert.equal(usage.cacheHitInputTokens, 0);
});

test('records persist metadata, exact provider usage and duration without input/output bodies', async t => {
  const { log, filePath } = await fixture(t);
  const call = await log.start({ operation: 'report', taskId: 'task-1', sourceId: 'source-1', model: 'test-model', text: 'private research text', apiKey: 'private-key' });
  let saved = (await log.list()).records[0];
  assert.equal(saved.status, 'running');
  assert.equal(saved.durationMs, null);
  assert.equal(saved.cost, null);
  call.onResponse(new Response(null, { status: 200, headers: { 'x-request-id': 'request-1' } }));
  call.onUsage({ prompt_tokens: 123, completion_tokens: 45, total_tokens: 168, prompt_cache_hit_tokens: 20 }, { model: 'test-model-v2', id: 'response-1', content: 'private model output' });
  await call.finish({ status: 'succeeded' });
  await call.finish({ status: 'failed', errorCode: 'IGNORED_DUPLICATE_FINISH' });
  saved = (await log.list({ taskId: 'task-1' })).records[0];
  assert.equal(saved.id, call.id);
  assert.equal(saved.status, 'succeeded');
  assert.equal(saved.model, 'test-model-v2');
  assert.equal(saved.providerRequestId, 'request-1');
  assert.equal(saved.httpStatus, 200);
  assert.equal(saved.usage.totalTokens, 168);
  assert.equal(saved.usage.cacheMissInputTokens, null);
  assert(Number.isSafeInteger(saved.durationMs));
  assert.equal(saved.cost, null);
  assert.equal(saved.sessionId, undefined);
  assert.equal((await log.list({ taskId: 'other-task' })).records.length, 0);
  const disk = await readFile(filePath, 'utf8');
  for (const secret of ['private research text', 'private-key', 'private model output']) assert(!disk.includes(secret));
});

test('retries are distinct records, concurrent writes retain every completed attempt', async t => {
  const { log } = await fixture(t);
  const calls = await Promise.all(Array.from({ length: 6 }, () => log.start({ operation: 'read', taskId: 'task-1', sourceId: 'same-source' })));
  await Promise.all(calls.map((call, index) => call.finish({ status: index ? 'succeeded' : 'failed', ...(index ? {} : { errorCode: 'WEB_HTTP_404' }) })));
  const records = (await log.list()).records;
  assert.equal(records.length, 6);
  assert.equal(new Set(records.map(record => record.id)).size, 6);
  assert.equal(records.filter(record => record.status === 'failed').length, 1);
  assert(records.every(record => record.sourceId === 'same-source' && record.cost === null));
});

test('retention removes old completed records while keeping active calls', async t => {
  const { log } = await fixture(t, { maxRecords: 3 });
  const active = await log.start({ operation: 'search' });
  for (let index = 0; index < 5; index++) {
    const call = await log.start({ operation: 'report', taskId: `task-${index}` });
    await call.finish({ status: 'succeeded' });
  }
  const { records, limit } = await log.list();
  assert.equal(limit, 3);
  assert.equal(records.length, 3);
  assert(records.some(record => record.id === active.id && record.status === 'running'));
  await active.finish({ status: 'cancelled', errorCode: 'CLIENT_CANCELLED' });
});

test('a restarted service marks prior incomplete calls interrupted without inventing usage or duration', async t => {
  const { log, filePath } = await fixture(t);
  await log.start({ operation: 'read', taskId: 'task-1' });
  const restarted = new CallLog({ filePath });
  const record = (await restarted.list()).records[0];
  assert.equal(record.status, 'interrupted');
  assert.equal(record.errorCode, 'SERVICE_RESTARTED');
  assert.equal(record.durationMs, null);
  assert.equal(record.usage.inputTokens, null);
  assert.equal(record.cost, null);
  assert(record.finishedAt);
});

test('corrupt stores fail closed without overwriting the original file', async t => {
  const { log, filePath } = await fixture(t);
  const bad = '{damaged original log';
  await writeFile(filePath, bad);
  await assert.rejects(log.list(), /调用记录暂时不可用/);
  await assert.rejects(log.start({ operation: 'report' }), /调用记录暂时不可用/);
  assert.equal(await readFile(filePath, 'utf8'), bad);
});

test('failed final writes preserve the initial record instead of reporting success', async t => {
  const { log, dir, filePath } = await fixture(t);
  const call = await log.start({ operation: 'report' });
  const initial = await readFile(filePath, 'utf8');
  await mkdir(path.join(dir, 'blocked'));
  log.filePath = path.join(dir, 'blocked');
  await assert.rejects(call.finish({ status: 'succeeded' }), /调用记录暂时不可用/);
  assert.equal(await readFile(filePath, 'utf8'), initial);
});
