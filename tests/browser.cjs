/* Run with Playwright installed locally, or set NODE_PATH to its package directory. */
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { existsSync } = require('node:fs');
const path = require('node:path');
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
    await page.locator('#load-demo').click();
    await page.locator('#confirm-cancel').click();
    assert.equal(await page.locator('#company').inputValue(), '测试公司');
    await page.locator('#load-demo').click();
    await page.locator('#confirm-accept').click();
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
    for (const width of [1280, 1024, 768, 659]) {
      await page.setViewportSize({ width, height: 900 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, `Review overflow at ${width}px`);
      assert.equal(await page.locator('#include-source').isVisible(), true);
      if (width === 659) {
        await page.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
        await page.screenshot({ path: path.join(root, 'outputs', '07-review-user-659.png'), fullPage: true });
      }
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

    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, deviceScaleFactor: 1, reducedMotion: 'reduce' });
    const mobilePage = await mobile.newPage();
    mobilePage.on('pageerror', error => errors.push(error.message));
    await mobilePage.goto(base);
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobilePage.screenshot({ path: path.join(root, 'outputs', '04-create-mobile.png'), fullPage: true });
    await mobilePage.locator('#load-demo').click();
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobilePage.locator('[data-select-source=demo-1]').click();
    assert.equal(await mobilePage.locator('#source-detail').evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.top >= 0 && box.top < innerHeight;
    }), true, 'Selecting a source on mobile must bring its detail into view');
    await mobilePage.locator('#back-to-sources').click();
    assert.equal(await mobilePage.locator('#source-list').evaluate(node => node.getBoundingClientRect().top < innerHeight), true);
    await mobilePage.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
    await mobilePage.screenshot({ path: path.join(root, 'outputs', '08-review-mobile.png'), fullPage: true });
    await mobilePage.locator('[data-select-source=demo-1]').click();
    await mobilePage.locator('#include-source').click();
    await mobilePage.locator('#to-report').click();
    await mobilePage.locator('#generate-report').click();
    assert.equal(await mobilePage.locator('.claim').count(), 1);
    assert.equal(await mobilePage.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await mobilePage.evaluate(() => { document.activeElement?.blur(); window.scrollTo(0, 0); document.querySelector('#toast').hidden = true; });
    await mobilePage.screenshot({ path: path.join(root, 'outputs', '05-report-mobile.png'), fullPage: true });
    await mobilePage.locator('#clear-workspace-mobile').click();
    await mobilePage.locator('#confirm-accept').click();
    assert.equal(await mobilePage.locator('#view-create').isVisible(), true);
    assert.deepEqual(errors, []);
    console.log('PASS: task validation, manual sources, unsafe URL rejection, duplicate hints, review filters, unavailable source guard, citation/export, report invalidation, reload recovery, demo confirmation, desktop/mobile and no page errors. No real API calls.');
    await mobile.close();
    await context.close();
  } finally {
    if (browser) await browser.close();
    child.kill();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
