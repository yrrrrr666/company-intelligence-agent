/* Synthetic, isolated browser regression. Run with Playwright installed or NODE_PATH set. */
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
const output = path.join(root, 'outputs', 'v0.5-library');

(async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'company-library-browser-'));
  const libraryPath = path.join(temporary, 'library.json');
  const company = '验收汽车股份有限公司（合成测试）';
  const cleanTitle = '季度汽车交付公告（合成测试）';
  const flaggedTitle = '<img src=x onerror="window.libraryHacked=true"> 待核实汽车交付';
  const cleanText = '合成测试资料，不代表真实公司披露。\n' + '这是不涉及汽车指标的背景段落，供检索上下文验证。\n'.repeat(32) + '本季度汽车交付 12000 辆；截至季末累计交付 30000 辆。季度与累计指标不可混用。\n' + '后续事项仅为合成测试文本，需按业务统计期间核对。\n'.repeat(18);
  let child;
  let browser;
  let base;
  const errors = [];
  const externalRequests = [];
  async function startServer(port = 0) {
    const code = `const {server}=await import('./src/server.mjs');server.listen(${port},'127.0.0.1',()=>console.log('TEST_URL=http://127.0.0.1:'+server.address().port));`;
    child = spawn(process.execPath, ['--input-type=module', '-e', code], {
      cwd: root,
      env: { ...process.env, PORT: String(port), LIBRARY_PATH: libraryPath, DEEPSEEK_API_KEY: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
    });
    let log = '';
    let errorLog = '';
    child.stdout.on('data', data => { log += data.toString(); });
    child.stderr.on('data', data => { errorLog += data.toString(); });
    for (let attempt = 0; attempt < 100; attempt++) {
      const address = log.match(/TEST_URL=(http:\/\/127\.0\.0\.1:\d+)/)?.[1];
      if (address) { base = address; return; }
      if (child.exitCode !== null) throw new Error(`Isolated server exited: ${errorLog}`);
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    throw new Error('Isolated library test service did not start');
  }
  async function stopServer() {
    if (!child || child.exitCode !== null) return;
    const closed = once(child, 'exit');
    child.kill();
    await closed;
  }
  async function setupPage(context) {
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => {
      const url = route.request().url();
      if (!url.startsWith(base + '/') && !url.startsWith('blob:') && !url.startsWith('data:')) {
        externalRequests.push(url);
        return route.abort();
      }
      if (/\/api\/(?:report|search|read)$/.test(url)) return route.fulfill({ status: 503, json: { error: '合成回归禁止真实服务调用' } });
      return route.continue();
    });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#model-status')?.textContent.includes('规则摘录'));
    return page;
  }
  async function createTask(page, topic = '汽车交付') {
    await page.locator('[data-step=create]').click();
    await page.locator('#company').fill(company);
    await page.locator('#start').fill('2026-10-01');
    await page.locator('#end').fill('2026-10-30');
    await page.locator('#topic').fill(topic);
    await page.locator('#task-form button[type=submit]').click();
    if (await page.locator('#confirm-dialog').isVisible()) await page.locator('#confirm-accept').click();
    await page.locator('#view-collect').waitFor({ state: 'visible' });
  }
  async function addSource(page, title, url, text, date) {
    await page.locator('#view-collect [data-action=add-source]').first().click();
    await page.locator('#source-title').fill(title);
    await page.locator('#source-url').fill(url);
    await page.locator('#source-publisher').fill('合成测试披露网站');
    await page.locator('#source-date').fill(date);
    await page.locator('#source-text').fill(text);
    await page.locator('#save-source').click();
    await page.locator('#source-dialog').waitFor({ state: 'hidden' });
  }
  async function archive(page) {
    const response = page.waitForResponse(response => response.url() === base + '/api/library/documents' && response.request().method() === 'POST');
    await page.locator('#archive-source').click();
    const result = await response;
    assert.equal(result.status(), 200);
    const data = await result.json();
    await page.waitForFunction(() => !document.querySelector('#archive-source')?.disabled);
    return data;
  }
  async function search(page, query, includeFlagged = false) {
    await page.locator('#library-query').fill(query);
    await page.locator('#library-include-flagged').setChecked(includeFlagged);
    const response = page.waitForResponse(response => response.url() === base + '/api/library/search' && response.request().method() === 'POST');
    await page.locator('#library-search-button').click();
    const result = await response;
    assert.equal(result.status(), 200);
    const data = await result.json();
    await page.waitForFunction(() => !document.querySelector('#library-search-button').disabled);
    assert.equal(data.mode, 'keyword');
    return data;
  }
  async function addResult(page, index) {
    const response = page.waitForResponse(response => response.url() === base + '/api/library/retrieve');
    await page.locator(`[data-add-library-result="${index}"]`).first().click();
    const result = await response;
    assert.equal(result.status(), 200);
    await page.waitForFunction(index => document.querySelector(`[data-add-library-result="${index}"]`)?.textContent.includes('已加入'), index);
  }
  async function screenshot(page, filename) {
    await page.locator('#toast').waitFor({ state: 'hidden', timeout: 6500 });
    await page.screenshot({ path: path.join(output, filename), fullPage: true });
  }
  try {
    await fs.mkdir(output, { recursive: true });
    await startServer();
    const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, acceptDownloads: true });
    const page = await setupPage(context);

    // Browsing an empty library does not create a research task; Escape returns focus.
    await page.locator('#open-library').click();
    await page.waitForFunction(() => document.querySelector('#library-status')?.textContent.includes('库内共 0'));
    assert.match(await page.locator('#library-task-hint').innerText(), /先返回工作台创建/);
    await screenshot(page, '01-empty-library-1440.png');
    await page.locator('#library-query').focus();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#view-create').isVisible(), true);
    assert.equal(await page.locator('#open-library').evaluate(node => node === document.activeElement), true);

    await createTask(page);
    await addSource(page, cleanTitle, 'https://example.com/synthetic/quarter', cleanText, '2026-10-20');
    await addSource(page, flaggedTitle, 'https://example.com/synthetic/pending', '合成测试资料。汽车交付累计 999 辆，日期和统计口径待核实。<script>window.libraryHacked=true</script>', '');
    await page.locator('[data-step=review]').click();
    await page.locator('[data-select-source]').first().click();
    assert.equal(await page.locator('#archive-source').isDisabled(), true);
    await page.locator('#include-source').click();
    assert.equal(await page.locator('#archive-source').isEnabled(), true);

    // Storage errors are visible and preserve the current inclusion decision; explicit retry works.
    await page.route('**/api/library/documents', route => route.request().method() === 'POST'
      ? route.fulfill({ status: 503, json: { error: '合成测试：磁盘暂时不可写' } }) : route.continue());
    await page.locator('#archive-source').click();
    await page.waitForFunction(() => document.querySelector('#archive-error')?.textContent.includes('磁盘暂时不可写'));
    assert.match(await page.locator('#source-detail').innerText(), /已纳入/);
    await page.unroute('**/api/library/documents');
    let clean = await archive(page);
    assert.equal(clean.duplicate, false);
    assert.equal((await archive(page)).duplicate, true);
    // A no-op metadata save keeps approval; a changed note requires new review before versioning.
    await page.locator('.source-metadata summary').click();
    await page.locator('#metadata-form button[type=submit]').click();
    assert.equal(await page.locator('#archive-source').isEnabled(), true);
    assert.match(await page.locator('#source-detail .detail-top').innerText(), /已纳入/);
    await page.locator('.source-metadata summary').click();
    await page.locator('#review-note').fill('核查记录：季度与累计口径已对照原文（合成测试）。');
    await page.locator('#metadata-form button[type=submit]').click();
    assert.match(await page.locator('#source-detail .detail-top').innerText(), /待审核/);
    assert.equal(await page.locator('#archive-source').isDisabled(), true);
    await page.locator('#include-source').click();
    clean = await archive(page);
    assert.equal(clean.document.version, 2);
    assert.equal(clean.duplicate, false);

    await page.locator('[data-select-source]').nth(1).click();
    await page.locator('#flag-source').check();
    await page.locator('#include-source').click();
    const flagged = await archive(page);
    assert(flagged.document.issues.includes('发布时间未知'));
    assert(flagged.document.issues.includes('人工标记待核实'));

    // The library persists on disk across local service restart and browser/task replacement.
    const port = Number(new URL(base).port);
    await stopServer();
    await startServer(port);
    await page.reload();
    await page.locator('#open-library').click();
    await page.waitForFunction(() => document.querySelector('#library-document-count')?.textContent === '2');
    await page.locator(`[data-library-document="${flagged.document.id}"]`).click();
    await page.waitForFunction(() => document.querySelector('#library-document-detail')?.textContent.includes('发布时间未知'));
    assert.equal(await page.locator('#library-document-detail img, #library-document-detail script').count(), 0);
    assert.equal(await page.evaluate(() => window.libraryHacked), undefined);
    await screenshot(page, '02-library-review-1440.png');
    await page.locator('#close-library').click();
    await page.locator('#clear-workspace').click();
    await page.locator('#confirm-accept').click();
    await page.locator('#open-library').click();
    await page.waitForFunction(() => document.querySelector('#library-document-count')?.textContent === '2');
    await page.locator('#close-library').click();
    await createTask(page, '汽车交付及季度口径');
    assert.equal(await page.locator('#collection-list [data-open-source]').count(), 0);
    await page.locator('#search-library').click();
    assert.equal(await page.locator('#library-company').inputValue(), company);
    assert.equal(await page.locator('#library-query').evaluate(node => node === document.activeElement), true);

    assert.equal((await search(page, '火星矿产储量')).results.length, 0);
    assert.match(await page.locator('#library-status').innerText(), /没有匹配/);
    const matches = await search(page, '汽车交付');
    assert(matches.results.length > 0);
    assert(matches.results.every(item => item.documentId === clean.document.id));
    assert(matches.results.every(item => cleanText.slice(item.chunk.start, item.chunk.end) === item.chunk.text));
    assert(matches.results.some(item => item.chunk.start > 0));
    for (const width of [1440, 1280, 1120]) {
      await page.setViewportSize({ width, height: 1000 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Library overflow at ${width}px`);
      assert.equal(await page.locator('#library-document-detail').evaluate(node => node.scrollWidth > node.clientWidth), false, `Library detail overflow at ${width}px`);
      assert.equal(await page.locator('#library-search-button').isVisible(), true);
      await screenshot(page, `03-library-search-${width}.png`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.locator('.library-date-options summary').click();
    await page.locator('#library-start').fill('2026-11-01');
    await page.locator('#library-end').fill('2026-11-30');
    assert.equal((await search(page, '汽车交付', true)).results.length, 0);
    await page.locator('#library-start').fill('');
    await page.locator('#library-end').fill('');

    // Delayed search and retrieval responses from replaced tasks must not mutate the new task.
    let releaseSearch;
    let sawSearch;
    const heldSearch = new Promise(resolve => { releaseSearch = resolve; });
    const searchStarted = new Promise(resolve => { sawSearch = resolve; });
    await page.route('**/api/library/search', async route => { sawSearch(); await heldSearch; await route.continue(); });
    await page.locator('#library-query').fill('汽车交付');
    await page.locator('#library-search-button').click();
    await searchStarted;
    await createTask(page, '汽车交付（搜索期间替换，合成测试）');
    const oldSearchResponse = page.waitForResponse(response => response.url() === base + '/api/library/search');
    releaseSearch();
    assert.equal((await oldSearchResponse).status(), 200);
    await page.unroute('**/api/library/search');
    assert.equal(await page.locator('#view-collect').isVisible(), true);
    assert.equal(await page.locator('#collection-list [data-open-source]').count(), 0);
    await page.locator('#search-library').click();
    await search(page, '汽车交付');
    let releaseRetrieve;
    let sawRetrieve;
    const heldRetrieve = new Promise(resolve => { releaseRetrieve = resolve; });
    const retrieveStarted = new Promise(resolve => { sawRetrieve = resolve; });
    await page.route('**/api/library/retrieve', async route => { sawRetrieve(); await heldRetrieve; await route.continue(); });
    await page.locator('[data-add-library-result="0"]').first().click();
    await retrieveStarted;
    await createTask(page, '汽车交付（加入期间替换，合成测试）');
    const oldRetrieveResponse = page.waitForResponse(response => response.url() === base + '/api/library/retrieve');
    releaseRetrieve();
    assert.equal((await oldRetrieveResponse).status(), 200);
    await page.unroute('**/api/library/retrieve');
    assert.equal(await page.locator('#view-collect').isVisible(), true);
    assert.equal(await page.locator('#collection-list [data-open-source]').count(), 0);
    await page.locator('#search-library').click();
    const cleanMatches = await search(page, '汽车交付');
    await addResult(page, 0);
    assert.equal(await page.locator('[data-add-library-result="0"]').first().isDisabled(), true);
    await page.locator('#close-library').click();
    assert.equal(await page.locator('#collection-list [data-open-source]').count(), 1);
    await page.locator('[data-step=review]').click();
    assert.match(await page.locator('#source-detail').innerText(), /待审核/);
    assert.match(await page.locator('#source-detail').innerText(), /检索片段/);
    assert.equal(await page.locator('#archive-source').count(), 0);
    await page.locator('#include-source').click();
    await page.locator('#to-report').click();
    await page.locator('#generate-report').click();
    assert((await page.locator('#report-body').innerText()).includes(`版本 ${clean.document.version}`));
    assert.match(await page.locator('#report-body').innerText(), /检索片段/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-report').click();
    const download = await downloadPromise;
    const exportPath = path.join(output, 'synthetic-library-brief.md');
    await download.saveAs(exportPath);
    const markdown = await fs.readFile(exportPath, 'utf8');
    assert(markdown.includes(clean.document.id));
    assert(markdown.includes(cleanMatches.results[0].chunk.id));
    assert(markdown.includes('检索词：汽车交付'));
    await screenshot(page, '04-library-report-1440.png');

    // Flagged evidence requires an explicit search toggle, then still arrives pending with warnings.
    await page.locator('[data-step=collect]').click();
    await page.locator('#search-library').click();
    const withFlagged = await search(page, '汽车交付', true);
    const flaggedIndex = withFlagged.results.findIndex(item => item.documentId === flagged.document.id);
    assert(flaggedIndex >= 0);
    await addResult(page, flaggedIndex);
    await page.locator('#close-library').click();
    await page.locator('[data-step=review]').click();
    assert.equal(await page.locator('[data-select-source]').count(), 2);
    assert.equal(await page.locator('#flag-source').isChecked(), true);
    assert.match(await page.locator('#source-detail').innerText(), /入库时：发布时间未知/);
    assert.equal(await page.locator('#source-detail img, #source-detail script').count(), 0);
    await page.locator('#include-source').click();
    await page.locator('#to-report').click();
    await page.locator('#generate-report').click();
    assert.match(await page.locator('.claim-source-warning').last().innerText(), /发布时间未知/);

    // Another task holds an old search result while a manager withdraws the source.
    const staleContext = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const stalePage = await setupPage(staleContext);
    await createTask(stalePage);
    await stalePage.locator('#search-library').click();
    await search(stalePage, '汽车交付');
    await page.locator('#open-library').click();
    await page.waitForFunction(() => document.querySelector('#library-document-count')?.textContent === '2');
    await page.locator(`[data-library-document="${clean.document.id}"]`).click();
    await page.locator('#withdraw-library-document').click();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.locator('#withdraw-library-document').isVisible(), true);
    await page.locator('#withdraw-library-document').click();
    await page.locator('#confirm-accept').click();
    await page.waitForFunction(() => document.querySelector('#library-document-detail')?.textContent.includes('此资料已撤回'));
    const staleResponse = stalePage.waitForResponse(response => response.url() === base + '/api/library/retrieve');
    await stalePage.locator('[data-add-library-result="0"]').first().click();
    assert.equal((await staleResponse).status(), 409);
    await stalePage.waitForFunction(() => document.querySelector('#library-error')?.textContent.includes('撤回'));
    await stalePage.locator('#close-library').click();
    assert.equal(await stalePage.locator('#collection-list [data-open-source]').count(), 0);
    assert.equal((await search(page, '汽车交付')).results.length, 0);
    await page.locator('#close-library').click();
    assert.equal(await page.locator('#view-report').isVisible(), true);
    assert.equal(await page.locator('#export-report').isEnabled(), true);
    assert((await page.locator('#report-body').innerText()).includes(clean.document.id));

    assert.equal(await page.evaluate(() => window.libraryHacked), undefined);
    assert.deepEqual(errors, []);
    assert.deepEqual(externalRequests, []);
    await fs.writeFile(path.join(output, 'browser-summary.json'), JSON.stringify({
      synthetic: true, node: process.version, cases: [
        'empty library and keyboard return', 'explicit reviewed archive', 'visible storage error and retry',
        'duplicate archive', 'persistent store across restart and task clearing', 'source/script escaping',
        'Chinese keyword search and no results', 'default flagged exclusion and explicit inclusion',
        'publication date filter', '1120/1280/1440 layouts', 'pending chunk import and dedup',
        'citation and Markdown provenance', 'warning inheritance', 'withdraw confirmation',
        'stale result refusal', 'existing report snapshot preservation',
        'metadata change requires reapproval and new version', 'no-op metadata keeps review',
        'delayed search after task replacement', 'delayed retrieval after task replacement'
      ], pageErrors: errors, externalRequests, viewports: [1120, 1280, 1440]
    }, null, 2));
    console.log('PASS: V0.5 isolated library browser regression (20 case groups), no real API calls, no page errors; artifacts outputs/v0.5-library.');
    await staleContext.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    await stopServer();
    const resolved = path.resolve(temporary);
    const tempRoot = path.resolve(os.tmpdir()) + path.sep;
    if (!resolved.startsWith(tempRoot) || !path.basename(resolved).startsWith('company-library-browser-')) throw new Error('Unexpected temporary cleanup path');
    await fs.rm(resolved, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
