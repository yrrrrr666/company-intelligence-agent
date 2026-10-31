/* Run with Playwright installed locally, or set NODE_PATH to its package directory. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
const { runImportChecks } = require('./import-checks.cjs');
const root = path.resolve(__dirname, '..');
const base = 'http://127.0.0.1:4175';

(async () => {
  const child = spawn(process.execPath, ['src/server.mjs'], { cwd: root, env: { ...process.env, PORT: '4175', DEEPSEEK_API_KEY: '' }, stdio: 'pipe', windowsHide: true });
  let browser;
  try {
    for (let attempt = 0; attempt < 40; attempt++) {
      try { if ((await fetch(base)).ok) break; } catch {}
      if (attempt === 39) throw new Error('Test server did not start');
      await new Promise(resolve => setTimeout(resolve, 150));
    }
    const chrome = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
    browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await fs.mkdir(path.join(root, 'outputs'), { recursive: true });
    await page.goto(base);
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('规则摘录'));
    assert.equal(await page.locator('#report-mode option[value=deepseek]').isDisabled(), true);
    assert.equal(await page.locator('.eyebrow').count(), 0);
    assert.equal(await page.locator('#company').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14), true);
    await page.locator('#company').focus();
    await page.keyboard.press('Tab');
    assert.equal(await page.locator('#start').evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle !== 'none'), true);
    await page.locator('#start').blur();
    await page.screenshot({ path: path.join(root, 'outputs', '01-create-desktop.png'), fullPage: true });
    assert.equal(await page.locator('#demo-sidebar').isVisible(), false);
    assert.equal(await page.locator('main #load-demo, main .sample-section').count(), 0);
    assert.equal(await page.locator('#clear-workspace-mobile, #back-to-sources').count(), 0);
    await page.locator('#toggle-demo-sidebar').click();
    assert.equal(await page.locator('#demo-sidebar').isVisible(), true);
    assert.equal(await page.locator('#toggle-demo-sidebar').getAttribute('aria-expanded'), 'true');
    assert.equal(await page.locator('#close-demo-sidebar').evaluate(node => node === document.activeElement), true);
    await page.screenshot({ path: path.join(root, 'outputs', '09-demo-sidebar-desktop.png'), fullPage: true });
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#demo-sidebar').isVisible(), false);
    assert.equal(await page.locator('#toggle-demo-sidebar').evaluate(node => node === document.activeElement), true);
    await page.locator('#toggle-demo-sidebar').click();
    await page.locator('#close-demo-sidebar').click();
    assert.equal(await page.locator('#toggle-demo-sidebar').getAttribute('aria-expanded'), 'false');
    await page.locator('#task-form button[type=submit]').click();
    assert.match(await page.locator('#company-error').innerText(), /填写/);
    await page.locator('#company').fill('测试公司');
    await page.locator('#start').fill('2026-10-15');
    await page.locator('#end').fill('2026-10-01');
    await page.locator('#topic').fill('产品发布');
    await page.locator('#task-form button[type=submit]').click();
    assert.match(await page.locator('#end-error').innerText(), /早于/);
    await page.locator('#end').fill('2026-10-20');
    await page.locator('#task-form button[type=submit]').click();
    assert.equal(await page.locator('#view-collect').isVisible(), true);
    assert.match(await page.locator('#collection-list').innerText(), /还没有/);
    await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(root, 'outputs', '06-collect-desktop.png'), fullPage: true });

    async function addSource(title, url, text, date = '') {
      await page.locator('#view-collect [data-action=add-source]').first().click();
      await page.locator('#source-title').fill(title);
      await page.locator('#source-url').fill(url);
      await page.locator('#source-text').fill(text);
      await page.locator('#source-date').fill(date);
      await page.locator('#source-form button[type=submit]').click();
    }
    await addSource('恶意链接测试', 'javascript:alert(1)', '文本');
    assert.match(await page.locator('#source-error').innerText(), /HTTP/);
    await page.locator('[data-close-dialog]').first().click();
    await addSource('<img src=x onerror=alert(1)>', 'https://example.com/news?utm_source=demo', '<script>window.hacked=true</script> 来源正文');
    await addSource('同一链接的另一条记录', 'https://example.com/news', '不应纳入的重复文本', '2026-10-16');
    await page.locator('#view-collect [data-go=review]').click();
    assert.match(await page.locator('#source-list').innerText(), /URL 重复候选/);
    await page.locator('[data-select-source]').first().click();
    assert.match(await page.locator('#source-detail').innerText(), /发布时间未知/);
    assert.equal(await page.locator('#source-detail script').count(), 0);
    assert.equal(await page.evaluate(() => window.hacked), undefined);
    assert.equal(await page.locator('#source-detail .saved-text').evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 14), true);
    await page.locator('#include-source').click();
    await page.locator('[data-select-source]').nth(1).click();
    await page.locator('#exclude-source').click();
    await page.locator('#to-report').click();
    await page.locator('#generate-report').click();
    assert.match(await page.locator('#report-body').innerText(), /来源正文/);
    assert.doesNotMatch(await page.locator('#report-body').innerText(), /不应纳入的重复文本/);
    assert.equal(await page.locator('#report-body script').count(), 0);
    assert.match(await page.locator('#report-body').innerText(), /发布时间未知/);
    const downloadPromise = page.waitForEvent('download');
    await page.locator('#export-report').click();
    const download = await downloadPromise;
    const exportPath = path.join(root, 'outputs', 'verified-export.md');
    await download.saveAs(exportPath);
    const exported = await fs.readFile(exportPath, 'utf8');
    assert(exported.includes('https://example.com/news?utm_source=demo'));
    assert(exported.includes('[来源 1](#source-1)'));
    assert(!exported.includes('不应纳入的重复文本'));
    await page.locator('[data-step=review]').click();
    await page.locator('[data-select-source]').first().click();
    await page.locator('#flag-source').check();
    await page.locator('[data-step=report]').click();
    assert.equal(await page.locator('#export-report').isDisabled(), true);
    await page.reload();
    assert.equal(await page.locator('[data-select-source]').count(), 2);
    await page.locator('[data-select-source]').first().click();
    assert.equal(await page.locator('#flag-source').isChecked(), true);

    await page.locator('[data-step=create]').click();
    await page.locator('#toggle-demo-sidebar').click();
    await page.locator('#load-demo').click();
    await page.keyboard.press('Escape');
    assert.equal(await page.locator('#confirm-dialog').isVisible(), false);
    assert.equal(await page.locator('#demo-sidebar').isVisible(), true);
    await page.locator('#load-demo').click();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.locator('#company').inputValue(), '测试公司');
    assert.equal(await page.locator('#demo-sidebar').isVisible(), true);
    await page.locator('#load-demo').click();
    await page.locator('#confirm-accept').click();
    assert.equal(await page.locator('#demo-sidebar').isVisible(), false);
    assert.equal(await page.locator('#main').evaluate(node => node === document.activeElement), true);
    assert.equal(await page.locator('#demo-notice').isVisible(), true);
    await page.locator('[data-select-source=demo-5]').click();
    assert.equal(await page.locator('#include-source').isDisabled(), true);
    await page.locator('[data-select-source=demo-4]').click();
    assert.match(await page.locator('#source-detail').innerText(), /超出研究范围/);
    await page.locator('#exclude-source').click();
    await page.locator('[data-select-source=demo-1]').click();
    await page.locator('#include-source').click();
    await page.locator('[data-select-source=demo-2]').click();
    await page.locator('#include-source').click();
    await page.locator('[data-filter=pending]').click();
    assert.equal(await page.locator('[data-select-source]').count(), 2);
    await page.locator('[data-filter=all]').click();
    for (const width of [1440, 1280, 1120]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Review overflow at ${width}px`);
      assert.equal(await page.locator('#include-source').isVisible(), true);
      await page.locator('#toggle-demo-sidebar').click();
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Sidebar overflow at ${width}px`);
      assert.equal(await page.locator('.review-workspace').evaluate(node => getComputedStyle(node).gridTemplateColumns.split(' ').length), 2);
      assert.equal(await page.locator('#source-detail').evaluate(node => node.scrollWidth <= node.clientWidth), true, `Detail overflow at ${width}px`);
      if (width === 1120) await page.screenshot({ path: path.join(root, 'outputs', '10-review-sidebar-1120.png'), fullPage: true });
      await page.locator('#close-demo-sidebar').click();
    }
    await page.setViewportSize({ width: 1440, height: 1080 });
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(root, 'outputs', '02-review-desktop.png'), fullPage: true });
    await page.locator('#to-report').click();
    await page.locator('#generate-report').click();
    assert.equal(await page.locator('.claim').count(), 2);
    assert.match(await page.locator('#report-body').innerText(), /虚构/);
    await page.locator('.citation').first().click();
    assert.equal(await page.locator('#report-source-1').isVisible(), true);
    await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
    await page.screenshot({ path: path.join(root, 'outputs', '03-report-desktop.png'), fullPage: true });

    // Exercise API failures and retry with synthetic responses; do not call a paid provider.
    await page.route('**/api/config', route => route.fulfill({ json: { modelAvailable: true, model: 'test-model', searchAvailable: false } }));
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('test-model'));
    await page.locator('#to-report').click();
    await page.locator('#report-mode').selectOption('deepseek');
    await page.route('**/api/report', route => route.fulfill({ status: 502, json: { error: '模拟服务失败，可重试' } }));
    await page.locator('#generate-report').click();
    await page.waitForFunction(() => document.querySelector('#report-error').textContent.includes('模拟服务失败'));
    assert.equal(await page.locator('#export-report').isDisabled(), true);
    await page.unroute('**/api/report');
    await page.route('**/api/report', route => route.fulfill({ json: { claims: [{ text: '【虚构演示】产品发布摘要', sourceIds: ['demo-1'] }] } }));
    await page.locator('#generate-report').click();
    await page.waitForFunction(() => document.querySelector('.claim')?.textContent.includes('产品发布摘要'));
    assert.equal(await page.locator('#export-report').isDisabled(), false);
    await page.locator('[data-step=review]').click();
    await page.locator('[data-select-source=demo-1]').click();
    assert.match(await page.locator('#source-detail').innerText(), /已纳入/);

    // A valid workspace can exceed the request budget because of excluded/pending
    // evidence. Send only approved text while retaining original citation numbers.
    await page.unroute('**/api/report');
    await page.evaluate(() => {
      const key = 'company-intelligence:current-task:v1';
      const saved = JSON.parse(localStorage.getItem(key));
      const template = saved.sources[0];
      saved.task = { ...saved.task, company: '请求回归公司（合成测试）', demo: false };
      saved.sources = Array.from({ length: 20 }, (_, index) => ({ ...template, id: `request-${index}`, title: `合成资料 ${index + 1}`, text: '字'.repeat(12000), review: index === 17 ? 'included' : index % 2 ? 'pending' : 'excluded', demo: false }));
      const body = JSON.stringify(saved);
      if (new TextEncoder().encode(body).byteLength <= 700000) throw new Error('Large-workspace fixture is too small');
      localStorage.setItem(key, body);
    });
    let reportRequests = 0;
    await page.route('**/api/report', async route => {
      reportRequests++;
      const input = route.request().postDataJSON();
      assert.equal(input.sources.length, 1);
      assert.equal(input.sources[0].id, 'request-17');
      assert.equal(input.sources[0].text, '字'.repeat(12000));
      assert(Buffer.byteLength(route.request().postData()) < 700000);
      await route.fulfill({ json: { claims: [{ text: '【合成测试】仅根据纳入资料整理', sourceIds: ['request-17'] }] } });
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('test-model'));
    await page.locator('#to-report').click();
    await page.locator('#report-mode').selectOption('deepseek');
    await page.locator('#generate-report').click();
    await page.waitForFunction(() => document.querySelector('.claim')?.textContent.includes('仅根据纳入资料'));
    assert.equal(reportRequests, 1);
    assert.equal(await page.locator('#report-source-18').count(), 1);
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('company-intelligence:current-task:v1')).sources.length), 20);
    assert.match(await page.locator('#report-body').innerText(), /尚未审核/);

    // Oversized approved text must fail before a paid request and remain reviewable.
    await page.evaluate(() => {
      const key = 'company-intelligence:current-task:v1';
      const saved = JSON.parse(localStorage.getItem(key));
      saved.sources.forEach((source, index) => { source.review = index < 7 ? 'included' : 'excluded'; });
      localStorage.setItem(key, JSON.stringify(saved));
    });
    await page.reload();
    await page.waitForFunction(() => document.querySelector('#model-status').textContent.includes('test-model'));
    await page.locator('#to-report').click();
    await page.locator('#report-mode').selectOption('deepseek');
    await page.locator('#generate-report').click();
    await page.waitForFunction(() => document.querySelector('#report-error').textContent.includes('80000'));
    assert.equal(reportRequests, 1);
    assert.equal(await page.locator('#generate-report').isEnabled(), true);
    assert.equal(await page.locator('#export-report').isDisabled(), true);

    const freshContext = await browser.newContext({ viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' });
    const freshPage = await freshContext.newPage();
    freshPage.on('pageerror', error => errors.push(error.message));
    await freshPage.goto(base);
    await freshPage.locator('#toggle-demo-sidebar').click();
    await freshPage.locator('#load-demo').click();
    assert.equal(await freshPage.locator('#demo-sidebar').isVisible(), false);
    assert.equal(await freshPage.locator('[data-select-source]').count(), 5);
    await freshPage.locator('#clear-workspace').click();
    await freshPage.locator('#confirm-accept').click();
    assert.equal(await freshPage.locator('#view-create').isVisible(), true);
    await freshPage.reload();
    assert.equal(await freshPage.locator('#view-create').isVisible(), true);
    assert.equal(await freshPage.locator('#demo-sidebar').isVisible(), false);
    await runImportChecks(browser, base, root, errors);
    assert.deepEqual(errors, []);
    console.log('PASS: desktop task validation, manual sources, unsafe input, review, citation/export, reload recovery, example sidebar, local PDF/TXT/Markdown import, approved-only report requests and capacity checks, keyboard focus, replacement confirmation, 1120/1280/1440 layouts and no page errors. No real API calls.');
    await freshContext.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
