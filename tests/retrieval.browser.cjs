/* Isolated synthetic UI regression for matched-context retrieval. No real model calls. */
let chromium;
try { ({ chromium } = require('playwright')); }
catch { ({ chromium } = require('../outputs/qa-runtime/node_modules/playwright')); }
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'outputs', 'v0.5.1-retrieval');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'company-retrieval-browser-'));
  let child;
  let browser;
  let base;
  const pageErrors = [];
  const externalRequests = [];
  const company = '检索验收汽车有限公司（合成测试）';
  const evidence = '2026 年第三季度汽车交付 12000 辆；截至 2026 年 9 月 30 日，累计交付 30000 辆。';
  const text = '【合成测试资料，不代表真实公司】\n' + '背景资料说明，仅供原文上下文检查。'.repeat(38) + '\n' + evidence + '\n<img src=x onerror="window.retrievalInjected=true"><script>window.retrievalInjected=true</script>\n' + '补充资料仅供合成回归使用，不是其他季度交付数据。'.repeat(15);
  const query = '第三季度汽车交付';
  assert(text.indexOf(evidence) > 500);
  const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
  async function screenshot(page, filename) {
    await page.locator('#toast').waitFor({ state: 'hidden', timeout: 6500 });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
  }
  async function search(page, term = query) {
    await page.locator('#library-query').fill(term);
    const pending = page.waitForResponse(response => response.url() === base + '/api/library/search');
    await page.locator('#library-search-button').click();
    const response = await pending;
    assert.equal(response.status(), 200);
    await page.waitForFunction(() => !document.querySelector('#library-search-button').disabled);
    return response.json();
  }
  try {
    await fs.mkdir(output, { recursive: true });
    const code = "const {server}=await import('./src/server.mjs');server.listen(0,'127.0.0.1',()=>console.log('TEST_URL=http://127.0.0.1:'+server.address().port));";
    child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, PORT: '0', LIBRARY_PATH: path.join(temporary, 'library.json'), DEEPSEEK_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let log = ''; let errorLog = '';
    child.stdout.on('data', data => { log += data; });
    child.stderr.on('data', data => { errorLog += data; });
    for (let attempt = 0; attempt < 100; attempt++) {
      base = log.match(/TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (base) break;
      if (child.exitCode !== null) throw new Error(`Isolated retrieval service exited: ${errorLog}`);
      await pause(80);
    }
    assert(base, 'Isolated retrieval service started');
    const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (!url.startsWith(base + '/') && !url.startsWith('blob:') && !url.startsWith('data:')) {
        externalRequests.push(url); return route.abort();
      }
      if (/\/api\/(?:report|search|read)$/.test(url)) return route.fulfill({ status: 503, json: { error: '合成检索回归禁止真实服务调用' } });
      return route.continue();
    });
    await page.goto(base);
    await page.locator('#company').fill(company);
    await page.locator('#start').fill('2026-10-01');
    await page.locator('#end').fill('2026-10-30');
    await page.locator('#topic').fill(query);
    await page.locator('#task-form button[type=submit]').click();
    await page.locator('#view-collect [data-action=add-source]').first().click();
    await page.locator('#source-title').fill('季度与累计交付公告（合成测试）');
    await page.locator('#source-url').fill('https://example.com/retrieval/synthetic-quarter');
    await page.locator('#source-publisher').fill('合成测试来源');
    await page.locator('#source-date').fill('2026-10-20');
    await page.locator('#source-text').fill(text);
    await page.locator('#save-source').click();
    await page.locator('[data-step=review]').click();
    await page.locator('#include-source').click();
    const save = page.waitForResponse(response => response.url() === base + '/api/library/documents' && response.request().method() === 'POST');
    await page.locator('#archive-source').click();
    assert.equal((await save).status(), 200);
    await page.locator('[data-step=collect]').click();
    await page.locator('#search-library').click();
    const found = await search(page);
    assert(found.results.length, 'Chinese query has matches');
    const first = found.results[0];
    assert(first.preview, 'Server provides a matched context');
    assert.equal(first.preview.text, text.slice(first.preview.start, first.preview.end));
    assert(first.preview.start > 0, 'Context is not blindly the first source characters');
    assert(first.preview.text.includes(evidence), 'Quarter, cumulative period and units stay together');
    assert(first.preview.text.length <= 480);
    const listText = await page.locator('.library-result-excerpt').first().innerText();
    assert(listText.includes(evidence), 'List preview exposes actual figures beyond the old first500 cutoff');
    assert.equal(await page.locator('.library-result-excerpt mark').count() > 0, true);
    assert.equal(await page.locator('#library-document-detail .library-matched-text mark').count() > 0, true);
    assert.match(await page.locator('#library-document-detail .saved-text-title').innerText(), /加入任务的文本/);
    assert.equal(await page.locator('#library-document-detail .library-matched-text').innerText(), first.preview.text);
    await page.locator('.library-container-text summary').click();
    assert.equal(await page.locator('.library-container-text .saved-text').innerText(), first.chunk.text);
    await page.locator('.library-container-text summary').click();
    await page.locator('.library-full-original summary').click();
    assert.equal(await page.locator('.library-full-original .saved-text').innerText(), text);
    assert.equal(await page.locator('#library-document-detail img, #library-document-detail script, #library-results img, #library-results script').count(), 0);
    assert.equal(await page.evaluate(() => window.retrievalInjected), undefined);
    await page.locator('.library-full-original summary').click();
    for (const width of [1440, 1280, 1120]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `No page overflow at ${width}`);
      assert.equal(await page.locator('#library-document-detail').evaluate(node => node.scrollWidth > node.clientWidth), false, `No detail overflow at ${width}`);
      await screenshot(page, `01-matched-context-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    // Ranges are data, never markup. Invalid bounds fall back to plain escaped text.
    await page.route('**/api/library/search', async route => {
      const response = await route.fetch();
      const payload = await response.json();
      for (const result of payload.results) result.preview.matchRanges = [{ start: -1, end: 999999 }];
      await route.fulfill({ response, json: payload });
    });
    await search(page);
    assert.equal(await page.locator('#library-results mark, #library-document-detail mark').count(), 0);
    assert.equal(await page.locator('#library-results img, #library-document-detail img').count(), 0);
    await page.unroute('**/api/library/search');
    const restored = await search(page);
    assert.equal(await page.locator('.library-result-excerpt mark').count() > 0, true);

    const adding = page.waitForResponse(response => response.url() === base + '/api/library/retrieve');
    await page.locator('[data-add-library-result="0"]').first().click();
    assert.equal((await adding).status(), 200);
    await page.waitForFunction(() => document.querySelector('[data-add-library-result="0"]')?.textContent.includes('已加入'));
    await page.locator('#close-library').click();
    await page.locator('[data-step=review]').click();
    assert.match(await page.locator('#source-detail').innerText(), /待审核/);
    const imported = await page.evaluate(() => JSON.parse(localStorage.getItem('company-intelligence:current-task:v1')).sources.find(source => source.library));
    assert(imported);
    assert.equal(imported.text, restored.results[0].preview.text);
    assert.equal(imported.library.start, restored.results[0].preview.start);
    assert.equal(imported.library.end, restored.results[0].preview.end);
    assert.equal(imported.text, text.slice(imported.library.start, imported.library.end));
    assert.equal(imported.review, 'pending');
    await page.locator('#include-source').click();
    // Exclude the original so the report proves the retrieved context alone retains the facts.
    await page.locator('[data-select-source]').first().click();
    await page.locator('#exclude-source').click();
    await page.locator('#to-report').click();
    await page.locator('#generate-report').click();
    const reportText = await page.locator('#report-body').innerText();
    assert(reportText.includes(evidence), 'Rule extract includes complete selected context, period and units');
    assert.match(reportText, /片段 chunk-/);
    const pendingDownload = page.waitForEvent('download');
    await page.locator('#export-report').click();
    const download = await pendingDownload;
    await download.saveAs(path.join(output, 'matched-context-brief.md'));
    const markdown = await fs.readFile(path.join(output, 'matched-context-brief.md'), 'utf8');
    assert(markdown.includes(evidence));
    assert(markdown.includes(`${imported.library.start + 1}–${imported.library.end}`));
    await screenshot(page, '02-matched-context-report-1440.png');

    // Different questions may need different contexts within the same container chunk.
    await page.locator('[data-step=collect]').click();
    await page.locator('#search-library').click();
    const anotherContext = await search(page, '背景资料说明');
    assert.equal(anotherContext.results[0].chunk.id, restored.results[0].chunk.id);
    assert(anotherContext.results[0].preview.start < imported.library.start);
    assert.equal(await page.locator('[data-add-library-result="0"]').first().isEnabled(), true);
    const addingContext = page.waitForResponse(response => response.url() === base + '/api/library/retrieve');
    await page.locator('[data-add-library-result="0"]').first().click();
    assert.equal((await addingContext).status(), 200);
    await page.waitForFunction(() => document.querySelector('[data-add-library-result="0"]')?.textContent.includes('已加入'));
    assert.equal(await page.locator('[data-add-library-result="0"]').first().isDisabled(), true);
    const reused = await page.evaluate(() => JSON.parse(localStorage.getItem('company-intelligence:current-task:v1')).sources.filter(source => source.library));
    assert.equal(reused.length, 2);
    assert.equal(reused[0].library.chunkId, reused[1].library.chunkId);
    assert.notEqual(reused[0].library.start, reused[1].library.start);
    assert.equal(reused[1].review, 'pending');
    assert.deepEqual(pageErrors, []);
    assert.deepEqual(externalRequests, []);
    await fs.writeFile(path.join(output, 'browser-summary.json'), JSON.stringify({
      synthetic: true,
      cases: ['matched facts after long source prefix', 'quarter and cumulative period preservation', 'safe keyword highlighting', 'invalid highlight bounds fail plain', 'full chunk and original inspection', 'exact imported context and pending review', 'rule extract and Markdown context provenance', 'distinct contexts in the same container chunk', '1120/1280/1440 layouts'],
      viewports: [1120, 1280, 1440], pageErrors, externalRequests,
      sourceLength: text.length, evidenceOffset: text.indexOf(evidence), importedContextLength: imported.text.length
    }, null, 2));
    console.log('PASS: matched-context preview/highlight, safe escaping, complete periods and units, exact pending import, rule report/export, desktop layouts. Synthetic data, no real API calls.');
  } finally {
    if (browser) await browser.close();
    if (child && child.exitCode === null) { const exited = once(child, 'exit'); child.kill(); await exited; }
    assert.equal(path.dirname(temporary), os.tmpdir());
    await fs.rm(temporary, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
