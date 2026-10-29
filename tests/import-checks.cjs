const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { makePdf } = require('./pdf-fixture.cjs');

exports.runImportChecks = async (browser, base, root, errors) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  const external = [];
  await page.route('**/*', route => {
    if (route.request().url().startsWith(base + '/')) return route.continue();
    external.push(route.request().url());
    return route.abort();
  });
  await page.goto(base);
  await page.locator('#company').fill('文件导入测试公司');
  await page.locator('#start').fill('2025-01-01');
  await page.locator('#end').fill('2025-12-31');
  await page.locator('#topic').fill('本地资料核查');
  await page.locator('#task-form button[type=submit]').click();
  assert.equal(await page.locator('#import-file-button').isVisible(), true);
  await page.screenshot({ path: path.join(root, 'outputs', '11-collect-file-import.png'), fullPage: true });

  const stored = () => page.evaluate(() => JSON.parse(localStorage.getItem('company-intelligence:current-task:v1')));
  async function choose(name, bytes, mimeType = 'text/plain') {
    await page.locator('#source-file').setInputFiles({ name, mimeType, buffer: Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes) });
  }
  async function ready() { await page.waitForFunction(() => document.querySelector('#import-progress').textContent.startsWith('已提取')); }
  async function save() {
    await page.locator('#save-source').click();
    await page.waitForFunction(() => !document.querySelector('#source-dialog').open);
  }

  const evidence = '【自主编写测试文本】企业发布资料。<script>window.importHacked=true</script>';
  await choose('本地资料.txt', evidence);
  await ready();
  assert.equal(await page.locator('#source-title').inputValue(), '本地资料');
  assert.equal(await page.locator('#source-date').inputValue(), '');
  assert.equal(await page.locator('#source-url-optional').isVisible(), true);
  await page.locator('#source-url').fill('javascript:alert(1)');
  await page.locator('#save-source').click();
  assert.match(await page.locator('#source-error').innerText(), /HTTP/);
  await page.locator('#source-url').fill('');
  await page.locator('#source-text').fill(evidence + '\n人工补充的测试文本。');
  await save();
  let data = await stored();
  assert.equal(data.sources.length, 1);
  assert.equal(data.sources[0].review, 'pending');
  assert.equal(data.sources[0].demo, false);
  assert.equal(data.sources[0].url, '');
  assert.match(data.sources[0].file.sha256, /^[a-f0-9]{64}$/);

  await choose('改名的资料.md', evidence);
  await ready();
  await save();
  await page.locator('#view-collect [data-go=review]').click();
  assert.match(await page.locator('#source-list').innerText(), /本地文件重复候选/);
  await page.locator('[data-select-source]').first().click();
  assert.match(await page.locator('#source-detail').innerText(), /本地文件：本地资料.txt/);
  assert.equal(await page.locator('#source-detail script').count(), 0);
  assert.equal(await page.evaluate(() => window.importHacked), undefined);
  await page.locator('#include-source').click();
  await page.locator('#to-report').click();
  await page.locator('#generate-report').click();
  assert.match(await page.locator('#report-body').innerText(), /本地资料.txt/);
  assert.doesNotMatch(await page.locator('#report-body').innerText(), /虚构演示资料/);
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-report').click();
  const download = await downloadPromise;
  const exportedPath = path.join(root, 'outputs', 'verified-local-file-export.md');
  await download.saveAs(exportedPath);
  const exported = await fs.readFile(exportedPath, 'utf8');
  assert(exported.includes('本地资料.txt'));
  assert(exported.includes('SHA-256：'));
  assert(exported.includes('人工补充的测试文本'));
  await page.reload();
  assert.equal((await stored()).sources[0].file.name, '本地资料.txt');
  await page.locator('[data-step=collect]').click();

  const pdf = makePdf();
  await choose('两页测试.pdf', pdf, 'application/pdf');
  await ready();
  assert.equal(await page.locator('#pdf-page-end').inputValue(), '2');
  assert.match(await page.locator('#source-text').inputValue(), /PAGE_ONE/);
  assert.match(await page.locator('#source-text').inputValue(), /PAGE_TWO/);
  await page.setViewportSize({ width: 1120, height: 900 });
  assert.equal(await page.locator('#source-dialog').evaluate(node => node.scrollWidth <= node.clientWidth), true);
  await page.setViewportSize({ width: 1440, height: 1080 });
  await page.locator('#pdf-page-start').fill('3');
  assert.equal(await page.locator('#save-source').isDisabled(), true);
  await page.locator('#extract-pages').click();
  assert.match(await page.locator('#source-error').innerText(), /页码范围/);
  await page.locator('#pdf-page-start').fill('2');
  await page.locator('#extract-pages').click();
  await ready();
  assert.doesNotMatch(await page.locator('#source-text').inputValue(), /PAGE_ONE/);
  assert.match(await page.locator('#source-text').inputValue(), /PAGE_TWO/);
  await page.screenshot({ path: path.join(root, 'outputs', '12-import-pdf-preview.png'), fullPage: true });
  await save();
  data = await stored();
  assert.equal(data.sources.length, 3);
  assert.equal(data.sources[2].file.pageStart, 2);
  assert.equal(data.sources[2].file.pageEnd, 2);
  assert.equal(data.sources[2].file.totalPages, 2);

  for (const [name, content, message] of [
    ['不支持.docx', 'document', /PDF/],
    ['空文件.txt', '', /为空/],
    ['大文件.txt', Buffer.alloc(10 * 1024 * 1024 + 1, 65), /10 MB/]
  ]) {
    await choose(name, content);
    assert.match(await page.locator('#toast').innerText(), message);
    assert.equal(await page.locator('#source-dialog').isVisible(), false);
  }
  for (const [name, content, message] of [
    ['二进制.txt', Buffer.from([0, 1, 2]), /二进制/],
    ['伪装.pdf', 'not a PDF', /有效 PDF/],
    ['损坏.pdf', '%PDF-1.7\ninvalid data\n%%EOF', /无法解析/]
  ]) {
    await choose(name, content, 'application/pdf');
    await page.waitForFunction(() => document.querySelector('#source-error').textContent);
    assert.match(await page.locator('#source-error').innerText(), message);
    assert.equal(await page.locator('#save-source').isDisabled(), true);
    await page.locator('[data-close-dialog]').first().click();
  }

  await choose('无文字.pdf', makePdf(['']), 'application/pdf');
  await ready();
  assert.match(await page.locator('#import-warning').innerText(), /文字识别/);
  await page.locator('#save-source').click();
  assert.match(await page.locator('#source-error').innerText(), /原文片段/);
  await page.locator('[data-close-dialog]').first().click();
  assert.equal((await stored()).sources.length, 3);

  await choose('超过100页.pdf', makePdf(Array.from({ length: 101 }, (_, i) => `Page ${i + 1}`)), 'application/pdf');
  await page.waitForFunction(() => document.querySelector('#import-progress').textContent.includes('请选取不超过'));
  assert.equal(await page.locator('#save-source').isDisabled(), true);
  await page.locator('#pdf-page-end').fill('2');
  await page.locator('#extract-pages').click();
  await ready();
  assert.match(await page.locator('#source-text').inputValue(), /Page 2/);
  await page.locator('[data-close-dialog]').first().click();

  await choose('长文本.txt', '测'.repeat(12001));
  await ready();
  assert.match(await page.locator('#import-warning').innerText(), /前 12,000 字/);
  await save();
  data = await stored();
  assert.equal(data.sources[3].text.length, 12000);
  assert.equal(data.sources[3].file.truncated, true);
  assert.equal(data.sources[3].flagged, true);

  await choose('取消.pdf', makePdf(Array.from({ length: 30 }, (_, i) => `Page ${i + 1}`)), 'application/pdf');
  await page.locator('[data-close-dialog]').first().click();
  await page.locator('#view-collect [data-action=add-source]').click();
  await page.locator('#source-title').fill('手动资料仍可正常录入');
  await page.locator('#source-url').fill('https://example.com/manual');
  await page.locator('#source-text').fill('自主编写的手动录入测试文本');
  await save();
  assert.equal((await stored()).sources.length, 5);
  await page.locator('[data-step=review]').click();
  await page.locator('[data-select-source]').nth(2).click();
  await page.evaluate(() => { document.querySelector('#toast').hidden = true; });
  await page.screenshot({ path: path.join(root, 'outputs', '13-review-local-file.png'), fullPage: true });
  for (const width of [1120, 1280, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  }
  assert.deepEqual(external, [], 'File extraction must not make remote requests');
  await context.close();
};
