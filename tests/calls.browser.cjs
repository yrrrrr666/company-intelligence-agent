/* Isolated call-history UI regression. The fixture blocks real upstream traffic. */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('../outputs/qa-runtime/node_modules/playwright')); }
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');

(async () => {
  const root = path.resolve(__dirname, '..');
  const output = path.join(root, 'outputs', 'v0.6-calls');
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'company-calls-browser-'));
  const child = spawn(process.execPath, ['tests/research-fixture-server.mjs'], { cwd: root, env: { ...process.env, PORT: '0', CALL_LOG_PATH: path.join(temporary, 'calls.json'), LIBRARY_PATH: path.join(temporary, 'library.json') }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  let browser;
  let logs = '';
  let errors = '';
  child.stderr.on('data', chunk => { errors += chunk; });
  try {
    const base = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture startup timed out: ' + errors)), 10000);
      child.stdout.on('data', chunk => {
        logs += chunk;
        const match = logs.match(/http:\/\/127\.0\.0\.1:\d+/);
        if (match) { clearTimeout(timer); resolve(match[0]); }
      });
      child.once('exit', code => { clearTimeout(timer); reject(new Error('Fixture exited ' + code + ': ' + errors)); });
    });
    const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    const pageErrors = [];
    const externalRequests = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('request', request => { if (!request.url().startsWith(base)) externalRequests.push(request.url()); });
    const rows = () => page.locator('#calls-rows>tr:not(.call-detail-row)');
    async function openHistory() {
      const loaded = page.waitForResponse(response => response.url().includes('/api/calls'));
      await page.locator('#open-calls').click();
      assert.equal((await loaded).status(), 200);
      await page.waitForFunction(() => !document.querySelector('#refresh-calls').disabled);
    }
    async function capture(name) {
      await page.evaluate(() => { window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
      await page.screenshot({ path: path.join(output, name), fullPage: true });
    }
    await fs.mkdir(output, { recursive: true });
    await page.goto(base);
    await openHistory();
    assert.equal(await page.locator('#calls-current').isDisabled(), true);
    assert.equal(await page.locator('#calls-empty').isVisible(), true);
    assert.equal(await page.locator('#export-calls').isDisabled(), true);
    await capture('empty-1440.png');
    await page.route('**/api/calls*', route => route.fulfill({ status: 503, json: { error: '合成测试：记录暂时不可用，请稍后刷新。' } }));
    await page.locator('#refresh-calls').click();
    await page.waitForFunction(() => document.querySelector('#calls-error').textContent.includes('合成测试'));
    assert.equal(await page.locator('#export-calls').isDisabled(), true);
    await capture('error-1440.png');
    await page.unroute('**/api/calls*');
    await page.locator('#close-calls').click();
    assert.equal(await page.locator('#open-calls').evaluate(node => node === document.activeElement), true);

    await page.locator('#company').fill('调用记录回归公司（合成测试）');
    await page.locator('#start').fill('2025-01-01');
    await page.locator('#end').fill('2025-12-31');
    await page.locator('#topic').fill('产品发布');
    await page.locator('#task-form button[type=submit]').click();
    await page.locator('#search-web').click();
    await page.waitForFunction(() => document.querySelector('#collection-progress').textContent.includes('读取完成'));
    await openHistory();
    assert.equal(await rows().count(), 3);
    assert.equal(await page.locator('#calls-current').isChecked(), true);
    await page.locator('#calls-status-filter').selectOption('failed');
    assert.equal(await rows().count(), 1);
    await page.locator('[data-call-detail]').click();
    assert.match(await page.locator('.call-detail-row:not([hidden])').innerText(), /WEB_HTTP_404/);
    await capture('failed-detail-1440.png');
    await page.locator('#calls-status-filter').selectOption('');
    await page.locator('#calls-operation').selectOption('read');
    assert.equal(await rows().count(), 2);
    const downloaded = page.waitForEvent('download');
    await page.locator('#export-calls').click();
    const download = await downloaded;
    const exportPath = path.join(output, 'calls-export.json');
    await download.saveAs(exportPath);
    const exported = JSON.parse(await fs.readFile(exportPath, 'utf8'));
    assert.equal(exported.records.length, 2);
    assert(exported.records.every(record => record.operation === 'read' && record.cost === null));
    assert(!JSON.stringify(exported).includes('仅搜索摘要'));

    await page.locator('#close-calls').click();
    const retry = page.waitForResponse(response => response.url().endsWith('/api/read'));
    await page.locator('[data-read-source]').click();
    assert.equal((await retry).status(), 200);
    await openHistory();
    assert.equal(await rows().count(), 3);
    await page.locator('#close-calls').click();
    await page.locator('[data-step=review]').click();
    await page.locator('[data-select-source]').first().click();
    await page.locator('#include-source').click();
    await page.locator('#to-report').click();
    await page.locator('#report-mode').selectOption('deepseek');
    await page.locator('#generate-report').click();
    await page.waitForFunction(() => !!document.querySelector('.claim'));
    await openHistory();
    await page.locator('#calls-operation').selectOption('report');
    assert.equal(await rows().count(), 1);
    assert.match(await rows().innerText(), /synthetic-model/);
    assert.equal(await rows().locator('td').nth(4).innerText(), '120');
    assert.equal(await rows().locator('td').nth(5).innerText(), '30');
    assert.equal(await rows().locator('td').nth(6).innerText(), '未知');
    await page.locator('[data-call-detail]').click();
    assert.match(await page.locator('.call-detail-row:not([hidden])').innerText(), /synthetic-provider-request/);
    for (const width of [1440, 1280, 1120]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      assert.equal(await page.locator('#calls-table-wrap').evaluate(node => node.scrollWidth > node.clientWidth), false);
      await capture(`model-detail-${width}.png`);
    }

    // A different task's request is retained globally but excluded from this task.
    const task = await page.evaluate(() => JSON.parse(localStorage.getItem('company-intelligence:current-task:v1')).task);
    const other = await fetch(base + '/api/search', { method: 'POST', headers: { Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify({ task: { ...task, id: 'other-task' }, query: '空结果' }) });
    assert.equal(other.status, 200);
    await page.locator('#calls-operation').selectOption('');
    await page.locator('#calls-current').uncheck();
    await page.waitForFunction(() => document.querySelector('#calls-summary').textContent.includes('显示 6 条'));
    assert.equal(await rows().count(), 6);
    await capture('all-calls-1120.png');
    await page.locator('#close-calls').click();

    // Stopping an in-flight read must leave an explicit cancelled record.
    await page.locator('[data-step=collect]').click();
    await page.locator('#search-query').fill('停止');
    const reading = page.waitForRequest(request => request.url().endsWith('/api/read'));
    await page.locator('#search-web').click();
    await reading;
    await openHistory();
    await page.locator('#calls-status-filter').selectOption('running');
    assert.equal(await rows().count(), 1);
    await capture('running-1120.png');
    await page.locator('#close-calls').click();
    await page.locator('#stop-collection').click();
    await openHistory();
    await page.locator('#calls-status-filter').selectOption('cancelled');
    for (let attempt = 0; await rows().count() === 0 && attempt < 10; attempt++) {
      await page.waitForTimeout(100);
      const refreshed = page.waitForResponse(response => response.url().includes('/api/calls'));
      await page.locator('#refresh-calls').click();
      await refreshed;
      await page.waitForFunction(() => !document.querySelector('#refresh-calls').disabled);
    }
    assert.equal(await rows().count(), 1);
    await page.locator('[data-call-detail]').click();
    assert.match(await page.locator('.call-detail-row:not([hidden])').innerText(), /CLIENT_CANCELLED/);
    await capture('cancelled-detail-1120.png');
    await page.locator('#close-calls').click();
    await page.locator('#clear-workspace').click();
    await page.locator('#confirm-accept').click();
    await page.reload();
    await openHistory();
    await page.locator('#calls-status-filter').selectOption('');
    assert.equal(await rows().count(), 8);
    assert.equal(await page.locator('#calls-current').isDisabled(), true);
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    console.log('PASS: isolated call history, empty/error, three real adapter paths with synthetic upstream, retry, exact usage/unknown fees, task and operation/status filters, export, cancellation, task clearing, focus return and 1120/1280/1440 layouts; no page errors or real API calls.');
    await context.close();
  } finally {
    if (browser) await browser.close();
    const exited = new Promise(resolve => child.once('exit', resolve));
    if (child.exitCode === null) { child.kill(); await exited; }
    assert.equal(path.dirname(temporary), os.tmpdir());
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
