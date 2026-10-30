import { STORAGE_KEY, MAX_SOURCES, validateTask, isDate, safeUrl, sourceIssues, eligibleSources, validateSources, validateModelClaims, createReport, reportMarkdown, demoWorkspace, localFileLabel, publicWebUrl, normalizeUrl, researchQuery, claimSourceWarnings } from './core.mjs';
import { checkLocalFile, openLocalFile, extractLocalText, validatePageRange, MAX_PDF_PAGES } from './import.mjs';
import { mergeSearchCandidates, saveWebText } from './research.mjs';
import { libraryResultSource } from './library.mjs';
import { librarySourceLabel } from './core.mjs';

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const icon = name => {
  const paths = { check: 'm5 12 4 4L19 6', external: 'M14 3h7v7M21 3 10 14M10 5H4v15h15v-6', file: 'M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h6' };
  return `<svg class="icon" viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name]}"/></svg>`;
};
let state = { task: null, sources: [], report: null };
let currentStep = 'create';
let selectedId = null;
let filter = 'all';
let toastTimer;
let pendingConfirmation = null;
let requestController = null;
let modelAvailable = false;
let fileDocument = null;
let fileLoadingTask = null;
let fileMetadata = null;
let fileGeneration = 0;
let fileBusy = false;
let fileMode = false;
let rangeDirty = false;
let searchAvailable = false;
let collectionController = null;
const libraryView = { documents: [], results: [], selectedDocument: null, selectedResult: null, panel: 'documents', returnStep: 'create', returnFocus: null, generation: 0, listRequest: 0, searchRequest: 0, query: '', busy: false, adding: new Set() };
const archiveRequests = new Set();

function toast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 4200);
}

function persist() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, task: state.task, sources: state.sources })); }
  catch { $('#storage-warning').hidden = false; }
}

function restore() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return;
    const saved = JSON.parse(stored);
    if (saved.version !== 1 || Object.keys(validateTask(saved.task || {})).length) throw new Error('invalid task');
    validateSources(saved.sources);
    state = { task: saved.task, sources: saved.sources, report: null };
    selectedId = state.sources[0]?.id;
  } catch {
    $('#storage-warning').textContent = '无法恢复上次任务，已打开空白工作台。原存储数据未被修改。';
    $('#storage-warning').hidden = false;
  }
}

function confirmAction(title, description, action, accept = '确认替换') {
  $('#confirm-title').textContent = title;
  $('#confirm-description').textContent = description;
  $('#confirm-accept').textContent = accept;
  pendingConfirmation = action;
  $('#confirm-dialog').showModal();
  $('#confirm-cancel').focus();
}

function replaceWorkspace(next, step) {
  libraryView.generation++;
  stopCollection(false);
  invalidateReport();
  state = next;
  selectedId = state.sources[0]?.id || null;
  filter = 'all';
  persist();
  fillTaskForm();
  go(step);
}

function fillTaskForm() {
  for (const field of ['company', 'start', 'end', 'topic']) {
    $(`#${field}`).value = state.task?.[field] || '';
    $(`#${field}-error`).textContent = '';
    $(`#${field}`).removeAttribute('aria-invalid');
  }
}

function invalidateReport() {
  state.report = null;
  if (requestController) requestController.abort();
  requestController = null;
  $('#generate-report').disabled = false;
  $('#generate-report').textContent = '生成简报';
  $('#report-error').textContent = '';
}

function go(step) {
  if (!state.task && !['create', 'library'].includes(step)) return;
  if (currentStep === 'library' && step !== 'library') libraryView.generation++;
  currentStep = step;
  for (const view of $$('.view')) view.hidden = view.id !== `view-${step}`;
  for (const button of $$('[data-step]')) {
    button.disabled = button.dataset.step !== 'create' && !state.task;
    const active = button.dataset.step === step;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  }
  $('#demo-notice').hidden = !state.sources.some(source => source.demo) && !state.task?.demo;
  $('#task-context').hidden = !state.task;
  $('#task-context').innerHTML = state.task ? `<div class="context-field"><span class="context-label">当前研究</span><strong class="context-company">${escape(state.task.company)}</strong></div><div class="context-field"><span class="context-label">研究时间</span><span class="context-value">${escape(state.task.start)} 至 ${escape(state.task.end)}</span></div><div class="context-field"><span class="context-label">关注主题</span><span>${escape(state.task.topic)}</span></div>` : '';
  if (step === 'collect') renderCollection();
  if (step === 'review') renderReview();
  if (step === 'report') renderReport();
  $('#open-library').setAttribute('aria-current', step === 'library' ? 'page' : 'false');
  if (step === 'library') renderLibrary();
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function renderCollection() {
  const task = state.task;
  if ($('#search-query').dataset.taskId !== task.id) {
    $('#search-query').value = researchQuery(task);
    $('#search-query').dataset.taskId = task.id;
    $('#collection-progress').textContent = '等待收集资料。';
    $('#collection-error').textContent = '';
  }
  const queries = [`"${task.company}" ${task.topic}`, `"${task.company}" 公告 ${task.start} ${task.end}`, `"${task.company}" ${task.topic} 官方`];
  $('#queries').innerHTML = queries.map((query, index) => `<div class="query-row"><code>${escape(query)}</code><button class="copy-query" data-copy-query="${index}" aria-label="复制第 ${index + 1} 条检索词">复制</button></div>`).join('');
  $$('[data-copy-query]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(queries[Number(button.dataset.copyQuery)]); toast('检索词已复制'); }
    catch { toast('无法复制，请选中检索词手动复制'); }
  }));
  $('#collect-count').innerHTML = `${state.sources.length} <small>条资料</small>`;
  $('#collect-summary').textContent = `${state.sources.filter(source => source.access === 'available' && source.text.trim()).length} 条有保存文本，${state.sources.filter(source => source.access !== 'available').length} 条无可用正文。`;
  $('#source-count').textContent = `共 ${state.sources.length} 条 / 上限 ${MAX_SOURCES} 条`;
  $('#collection-list').innerHTML = state.sources.length ? state.sources.map(source => `<div class="collection-row"><div><strong>${escape(source.title)}</strong><p>${escape(source.publisher || '来源未知')}，${escape(source.date || '发布时间未知')}，${source.web ? ({ pending: '等待读取正文', available: '网页正文已保存', failed: '正文读取失败' })[source.web.status] : source.access === 'available' ? (source.file ? '本地导入文本' : '已保存文本') : '无可用正文'}${source.demo ? '（虚构演示）' : ''}</p>${source.web?.error ? `<p class="collection-read-error">${escape(source.web.error)}</p>` : ''}</div><div class="collection-row-actions">${source.web && source.web.status !== 'available' ? `<button class="link-button" data-read-source="${escape(source.id)}" ${collectionController || !searchAvailable ? 'disabled' : ''}>${source.web.status === 'failed' ? '重试读取' : '读取正文'}</button>` : ''}<button class="link-button" data-open-source="${escape(source.id)}">查看资料</button></div></div>`).join('') : '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>还没有研究资料</h2><p>搜索公开资料、读取网页，或导入本地文件，再进入人工审核。</p><button class="button secondary" data-action="add-source">录入第一条资料</button></div>';
  $$('[data-open-source]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.openSource; filter = 'all'; go('review'); }));
  bindReadButtons();
  updateResearchControls();
}

function updateResearchControls() {
  const busy = !!collectionController;
  $('#search-web').disabled = busy || !searchAvailable || state.sources.length >= MAX_SOURCES;
  $('#read-url-button').disabled = busy || !searchAvailable;
  $('#read-pending').disabled = busy || !searchAvailable || !state.sources.some(source => source.web && source.web.status !== 'available' && source.review !== 'excluded');
  $('#search-query').disabled = busy;
  $('#read-url').disabled = busy;
  $('#stop-collection').hidden = !busy;
  $('#research-availability').textContent = searchAvailable ? 'DeepSeek Search / Fetch 已配置' : '需配置 DeepSeek 后使用';
  $$('[data-read-source]').forEach(button => { button.disabled = busy || !searchAvailable; });
}

function stopCollection(announce = true) {
  collectionController?.abort();
  collectionController = null;
  if (announce) $('#collection-progress').textContent = '已停止收集，已完成结果仍保留；未读取的资料可继续读取。';
  updateResearchControls();
}

function collectionChanged() {
  invalidateReport();
  persist();
  if (currentStep === 'collect') renderCollection();
  else if (currentStep === 'review') renderReview();
  else if (currentStep === 'report') renderReport();
}

async function researchPost(route, body, signal) {
  const response = await fetch(route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || '资料服务不可用，请重试。');
  return payload;
}

async function readSources(ids, controller, active, prefix = '') {
  let succeeded = 0;
  let failed = 0;
  for (const [index, id] of ids.entries()) {
    if (!active()) return;
    const source = state.sources.find(item => item.id === id);
    if (!source?.web || source.web.status === 'available') continue;
    $('#collection-progress').textContent = `${prefix}正在读取 ${index + 1}/${ids.length}：${source.title}`;
    try {
      const page = await researchPost('/api/read', { url: source.url }, controller.signal);
      if (!active()) return;
      const position = state.sources.findIndex(item => item.id === id);
      state.sources[position] = saveWebText(state.sources[position], page);
      succeeded++;
    } catch (error) {
      if (!active() || controller.signal.aborted) return;
      const current = state.sources.find(item => item.id === id);
      current.web.status = 'failed';
      current.web.error = (error.message || '正文读取失败，可重试。').slice(0, 500);
      failed++;
    }
    collectionChanged();
  }
  if (active()) $('#collection-progress').textContent = `${prefix}读取完成：${succeeded} 条成功，${failed} 条失败。候选资料均需审核后纳入简报。`;
}

async function runCollection(work) {
  if (collectionController || !state.task || !searchAvailable) return;
  const controller = new AbortController();
  const taskId = state.task.id;
  collectionController = controller;
  const active = () => collectionController === controller && state.task?.id === taskId;
  $('#collection-error').textContent = '';
  updateResearchControls();
  try { await work(controller, active); }
  catch (error) {
    if (active() && !controller.signal.aborted) {
      $('#collection-error').textContent = error.message || '资料收集失败，请重试。';
      $('#collection-progress').textContent = '收集未完成，已有资料和审核选择仍保留。';
    }
  } finally {
    if (active()) {
      collectionController = null;
      updateResearchControls();
    }
  }
}

function bindReadButtons() {
  $$('[data-read-source]').forEach(button => button.addEventListener('click', () => runCollection((controller, active) => readSources([button.dataset.readSource], controller, active))));
}

$('#search-form').addEventListener('submit', event => {
  event.preventDefault();
  const query = $('#search-query').value.trim();
  if (!query || [...query].length > 128) { $('#collection-error').textContent = '检索词须为 1–128 个字符。'; return; }
  void runCollection(async (controller, active) => {
    $('#collection-progress').textContent = '正在搜索公开资料…';
    const result = await researchPost('/api/search', { task: state.task, query }, controller.signal);
    if (!active()) return;
    const merged = mergeSearchCandidates(state.sources, result.candidates, result.query);
    if (!merged.added.length) {
      $('#collection-progress').textContent = result.candidates.length ? `未新增资料：跳过 ${merged.duplicates} 条重复链接，${merged.omitted} 条无效或超限候选。原资料未改动，可调整检索词。` : '未找到候选资料，可调整检索词或导入本地文件。';
      return;
    }
    state.sources = merged.sources;
    const prefix = `新增 ${merged.added.length} 条候选，跳过 ${merged.duplicates} 条重复、${merged.omitted} 条无效或超限结果。`;
    collectionChanged();
    await readSources(merged.added.map(source => source.id), controller, active, prefix);
  });
});

$('#read-url-form').addEventListener('submit', event => {
  event.preventDefault();
  const url = publicWebUrl($('#read-url').value.trim());
  if (!url) { $('#collection-error').textContent = '请填写公开网站地址，不支持本机、内网、IP 或带登录信息的链接。'; return; }
  void runCollection(async (controller, active) => {
    let source = state.sources.find(item => normalizeUrl(item.url) === normalizeUrl(url));
    if (source && (!source.web || source.web.status === 'available')) { $('#collection-progress').textContent = '此链接已有保存文本，原资料未改动，请在审核页查看。'; return; }
    if (!source) {
      const merged = mergeSearchCandidates(state.sources, [{ url }]);
      if (!merged.added.length) throw new Error('资料数量已达上限，请继续审核已有资料。');
      state.sources = merged.sources;
      source = merged.added[0];
      collectionChanged();
    }
    await readSources([source.id], controller, active);
  });
});
$('#read-pending').addEventListener('click', () => runCollection((controller, active) => readSources(state.sources.filter(source => source.web && source.web.status !== 'available' && source.review !== 'excluded').slice(0, 5).map(source => source.id), controller, active)));
$('#stop-collection').addEventListener('click', () => stopCollection());

function reviewLabel(source) { return ({ pending: '待审核', included: '已纳入', excluded: '已排除' })[source.review]; }
function needsCheck(source) { return sourceIssues(source, state.task, state.sources).some(issue => issue !== '虚构演示资料'); }
function filteredSources() {
  return state.sources.filter(source => filter === 'all' || (filter === 'flagged' ? needsCheck(source) : source.review === filter));
}

function renderReview() {
  const included = eligibleSources(state.sources);
  $('#review-stats').innerHTML = [
    ['收集资料', state.sources.length, ''], ['待审核', state.sources.filter(source => source.review === 'pending').length, ''],
    ['已纳入', included.length, 'green'], ['待核实', state.sources.filter(needsCheck).length, 'orange']
  ].map(([label, count, color]) => `<div class="stat ${color}"><span>${label}</span><strong>${count}</strong></div>`).join('');
  for (const button of $$('[data-filter]')) {
    button.classList.toggle('selected', filter === button.dataset.filter);
    button.setAttribute('aria-pressed', String(filter === button.dataset.filter));
  }
  const visible = filteredSources();
  if (!visible.some(source => source.id === selectedId)) selectedId = visible[0]?.id || null;
  $('#source-list').innerHTML = visible.length ? visible.map(source => {
    const issues = sourceIssues(source, state.task, state.sources);
    return `<button class="source-item ${source.id === selectedId ? 'selected' : ''}" data-select-source="${escape(source.id)}" aria-pressed="${source.id === selectedId}"><span class="source-order">资料 ${state.sources.indexOf(source) + 1}</span><h3>${escape(source.title)}</h3><p>${escape(source.publisher || '来源未知')}，${escape(source.date || '日期未知')}</p><div class="tags"><span class="tag ${source.review === 'included' ? 'green' : ''}">${reviewLabel(source)}</span>${issues.filter(issue => issue !== '人工标记待核实' && issue !== '虚构演示资料').map(issue => `<span class="tag ${issue === '没有可用正文' ? 'red' : 'orange'}">${escape(issue)}</span>`).join('')}${source.flagged ? '<span class="tag orange">待核实</span>' : ''}${source.demo ? '<span class="tag">演示</span>' : ''}</div></button>`;
  }).join('') : '<div class="empty-state"><h2>此筛选下暂无资料</h2><p>切换筛选查看其他资料，或录入新来源。</p></div>';
  $$('[data-select-source]').forEach(button => button.addEventListener('click', () => {
    selectedId = button.dataset.selectSource;
    renderReview();
    $(`[data-select-source="${selectedId}"]`)?.focus({ preventScroll: true });
  }));
  renderDetail();
  $('#selection-hint').textContent = included.length ? `已纳入 ${included.length} 条资料。简报仅使用纳入且有正文的来源。` : '尚未纳入资料。请先查看原文，再选择纳入。';
  $('#to-report').disabled = !included.length;
}

function renderDetail() {
  const source = state.sources.find(source => source.id === selectedId);
  if (!source) {
    $('#source-detail').innerHTML = '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>选择一条资料，开始核查</h2><p>检查公司、时间、主题和正文是否匹配。</p></div>';
    return;
  }
  const issues = sourceIssues(source, state.task, state.sources);
  const accessDescription = source.library ? '资料库检索片段（非全文）' : source.web ? ({ pending: '候选链接，尚未读取正文', available: 'DeepSeek Fetch 读取的网页正文', failed: '网页读取失败，可重试' })[source.web.status] : source.access === 'available' ? (source.file ? '本地文件文本，可经人工编辑' : '已录入文本，未联网读取') : '无可用正文';
  const webInfo = source.web ? `<div class="web-provenance"><p>正文服务：DeepSeek Fetch · 读取时间：${source.web.fetchedAt ? escape(new Date(source.web.fetchedAt).toLocaleString('zh-CN', { hour12: false })) : '尚未读取'}</p><p>保存 ${source.text.length} 字 / 提取 ${source.web.originalChars} 字${source.web.truncated ? '，正文已截取' : ''}；日期${source.web.dateOrigin === 'reviewed' ? '已人工确认' : source.web.dateOrigin === 'search' ? '由搜索服务提供，待核实' : '未知'}</p>${source.web.error ? `<p class="field-error">${escape(source.web.error)}</p>` : ''}${source.web.status !== 'available' ? `<button class="button secondary" data-read-source="${escape(source.id)}" ${collectionController || !searchAvailable ? 'disabled' : ''}>${source.web.status === 'failed' ? '重试读取' : '读取正文'}</button>` : ''}${source.web.snippet ? `<details><summary>搜索摘要（非正文，不用于简报）</summary><p>${escape(source.web.snippet)}</p></details>` : ''}</div>` : '';
  const metadataForm = `<details class="source-metadata"><summary>核实来源信息与备注</summary><form id="metadata-form" novalidate><div class="field"><label for="review-publisher">来源名称</label><input id="review-publisher" name="publisher" maxlength="120" value="${escape(source.publisher)}"></div><div class="field"><label for="review-date">资料发布日期</label><input id="review-date" name="date" type="date" value="${escape(source.date)}"><span class="field-help">请核对原文。无法确认时留空，不以采集时间代替。</span></div><div class="field"><label for="review-note">核查备注</label><textarea id="review-note" name="note" rows="2" maxlength="500" placeholder="记录口径差异、缺失信息或核查依据">${escape(source.note)}</textarea></div><p id="metadata-error" class="field-error" role="alert"></p><button class="button secondary" type="submit">确认并保存来源信息</button></form></details>`;
  $('#source-detail').innerHTML = `<div class="detail-top"><span>资料 ${state.sources.indexOf(source) + 1}</span><span>${escape(reviewLabel(source))}</span></div>
    <h2>${escape(source.title)}</h2>
    <dl class="detail-facts"><div><dt>来源名称</dt><dd>${escape(source.publisher || '未知')}</dd></div><div><dt>发布时间</dt><dd>${escape(source.date || '未知')}</dd></div><div><dt>收集时间</dt><dd>${escape(new Date(source.collectedAt).toLocaleString('zh-CN', { hour12: false }))}</dd></div><div><dt>资料状态</dt><dd>${escape(accessDescription)}</dd></div></dl>
    <div class="source-link">${safeUrl(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">打开来源 ${icon('external')}</a><p class="muted small">${escape(source.url)}</p>` : source.file ? '本地文件 · 未提供外部链接' : '无外部链接（虚构演示资料）'}</div>
    ${issues.length ? `<div class="issue-list">核查提示：${issues.map(escape).join('；')}</div>` : ''}
    ${source.library ? `<p class="library-source-note">${escape(librarySourceLabel(source))}</p><p class="library-source-note">检索词：${escape(source.library.query)}<br>检索时间：${escape(libraryDate(source.library.retrievedAt))}</p>` : ''}${source.file ? `<p class="local-file-note">${escape(localFileLabel(source))}</p><details class="local-file-note"><summary>文件指纹（SHA-256）</summary><p>${escape(source.file.sha256)}</p></details>` : ''}${webInfo}${source.note ? `<p class="source-check-note">核查备注：${escape(source.note)}</p>` : ''}${metadataForm}<div class="saved-text-title">${source.library ? '检索片段（非全文）' : '保存文本'}</div><div class="saved-text">${escape(source.text || '没有可用正文，无法纳入报告。')}</div>
    <div class="detail-actions"><button class="button include" id="include-source" ${!source.text.trim() || source.access !== 'available' ? 'disabled' : ''}>${icon('check')}${source.review === 'included' ? '已纳入简报' : '纳入简报'}</button><button class="button secondary" id="exclude-source">${source.review === 'excluded' ? '已排除' : '排除此资料'}</button></div>
    <div class="detail-foot"><label class="flag-label"><input id="flag-source" type="checkbox" ${source.flagged ? 'checked' : ''}> 标记待核实</label>${source.review !== 'pending' ? '<button id="reset-review" class="link-button">撤销审核</button>' : ''}</div>
    ${!source.demo && !state.task?.demo && !source.library ? `<div class="archive-actions"><button id="archive-source" class="button secondary" ${source.review !== 'included' || !source.text.trim() || source.access !== 'available' || archiveRequests.has(source.id) ? 'disabled' : ''}>${archiveRequests.has(source.id) ? '正在保存…' : '保存到资料库'}</button><p class="field-help">${source.review === 'included' ? '单独保存已审核正文、来源和核查提示，供后续任务复用。' : '先核查并纳入此资料，再保存到资料库。'}</p><p id="archive-error" class="field-error" role="alert"></p></div>` : source.library ? '<p class="field-help library-source-note">此内容为库内原文的检索片段，不重复入库。修改当前审核不影响资料库原记录。</p>' : ''}`;
  $('#archive-source')?.addEventListener('click', () => archiveSource(source.id));
  $('#include-source').addEventListener('click', () => reviewSource(source.id, 'included'));
  $('#exclude-source').addEventListener('click', () => reviewSource(source.id, 'excluded'));
  $('#reset-review')?.addEventListener('click', () => reviewSource(source.id, 'pending'));
  bindReadButtons();
  $('#metadata-form').addEventListener('submit', event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    for (const key of Object.keys(data)) data[key] = data[key].trim();
    if ((data.date && !isDate(data.date)) || data.publisher.length > 120 || data.note.length > 500) { $('#metadata-error').textContent = '请检查日期格式、来源名称和备注长度。'; return; }
    const metadataChanged = Object.keys(data).some(key => source[key] !== data[key]) || (source.web && source.web.dateOrigin !== (data.date ? 'reviewed' : 'unknown'));
    const requiresReview = metadataChanged && source.review === 'included';
    Object.assign(source, data);
    if (source.web) source.web.dateOrigin = data.date ? 'reviewed' : 'unknown';
    if (requiresReview) source.review = 'pending';
    invalidateReport(); persist(); renderReview();
    toast(requiresReview ? '来源信息已变更，请重新审核纳入后再保存到资料库或生成简报。' : '来源信息已保存，简报需重新生成。');
  });
  $('#flag-source').addEventListener('change', event => {
    source.flagged = event.target.checked;
    invalidateReport(); persist(); renderReview();
    $('#flag-source')?.focus({ preventScroll: true });
    toast(source.flagged ? '已标记待核实，生成简报时将保留提示' : '已取消人工标记；日期与正文提示仍会保留');
  });
}

function reviewSource(id, status) {
  const source = state.sources.find(source => source.id === id);
  if (status === 'included' && (!source.text.trim() || source.access !== 'available')) return;
  if (source.review === status) return;
  source.review = status;
  invalidateReport(); persist(); renderReview();
  $(`[data-select-source="${selectedId}"]`)?.focus({ preventScroll: true });
  toast(`${reviewLabel(source)}：${source.title}`);
}

async function libraryRequest(url, options = {}) {
  const response = await fetch(url, options);
  let payload;
  try { payload = await response.json(); }
  catch { throw new Error('资料库未返回有效结果，请检查本地服务后重试。'); }
  if (!response.ok) throw new Error(payload.error || '资料库操作失败，请重试。');
  return payload;
}

function libraryPost(url, input) {
  return libraryRequest(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) });
}

async function archiveSource(id) {
  const source = state.sources.find(item => item.id === id);
  if (!source || source.review !== 'included' || source.demo || state.task?.demo || source.library || !source.text.trim() || source.access !== 'available' || archiveRequests.has(id)) return;
  const taskId = state.task.id;
  const input = { task: structuredClone(state.task), source: structuredClone(source) };
  archiveRequests.add(id);
  renderDetail();
  try {
    const payload = await libraryPost('/api/library/documents', input);
    if (state.task?.id === taskId) toast(payload.duplicate ? '资料库已有相同版本，无须重复保存。' : `已保存到资料库 · 版本 ${payload.document.version}，核查提示一并保留。`);
  } catch (error) {
    if (state.task?.id === taskId && selectedId === id && $('#archive-error')) $('#archive-error').textContent = error.message;
    else if (state.task?.id === taskId) toast(error.message);
  } finally {
    archiveRequests.delete(id);
    if (state.task?.id === taskId && selectedId === id && $('#archive-source')) {
      $('#archive-source').disabled = source.review !== 'included';
      $('#archive-source').textContent = '保存到资料库';
    }
  }
}

function openLibrary(fromSearch = false) {
  if (currentStep !== 'library') {
    libraryView.returnStep = currentStep;
    libraryView.returnFocus = document.activeElement;
  }
  libraryView.generation++;
  libraryView.busy = false;
  libraryView.adding.clear();
  libraryView.documents = [];
  libraryView.results = [];
  libraryView.selectedResult = null;
  libraryView.selectedDocument = null;
  libraryView.panel = 'documents';
  if (state.task) $('#library-company').value = state.task.company;
  $('#library-query').value = fromSearch ? state.task?.topic || '' : '';
  $('#library-start').value = '';
  $('#library-end').value = '';
  $('#library-include-flagged').checked = false;
  $('#library-error').textContent = '';
  go('library');
  loadLibraryDocuments();
  if (fromSearch) $('#library-query').focus();
}

function closeLibrary() {
  const step = state.task ? libraryView.returnStep : 'create';
  const previousFocus = libraryView.returnFocus;
  go(step === 'library' ? 'create' : step);
  if (previousFocus?.isConnected && !previousFocus.closest('[hidden]')) previousFocus.focus({ preventScroll: true });
  else $('#open-library').focus({ preventScroll: true });
}

function libraryCurrent(generation) { return currentStep === 'library' && generation === libraryView.generation; }
function normalizedCompany(value) { return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN'); }
function alreadyAdded(result) { return state.sources.some(source => source.library?.documentId === result.documentId && source.library.version === result.version && source.library.chunkId === result.chunk.id); }
function resultCanAdd(result) { return !!state.task && !state.task.demo && normalizedCompany(state.task.company) === normalizedCompany(result.company) && state.sources.length < MAX_SOURCES && !alreadyAdded(result); }
function libraryDate(value) { return value ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知'; }

function renderLibrary() {
  const resultsMode = libraryView.panel === 'results';
  $('#library-document-list').hidden = resultsMode;
  $('#library-results').hidden = !resultsMode;
  $('#library-documents-tab').classList.toggle('selected', !resultsMode);
  $('#library-documents-tab').setAttribute('aria-pressed', String(!resultsMode));
  $('#library-results-tab').classList.toggle('selected', resultsMode);
  $('#library-results-tab').setAttribute('aria-pressed', String(resultsMode));
  $('#library-document-count').textContent = libraryView.documents.length;
  $('#library-result-count').textContent = libraryView.results.length;
  $('#library-search-button').disabled = libraryView.busy;
  $('#library-search-button').textContent = libraryView.busy ? '正在检索…' : '检索相关片段';
  $('#library-task-hint').textContent = !state.task ? '先返回工作台创建研究任务，才能把检索片段加入任务。浏览资料不会创建或替换任务。' : state.task.demo ? '当前为虚构示例任务。请创建正式研究任务后复用库内资料。' : `当前任务：${state.task.company}。检索片段加入后仍为待审核，确认纳入后才用于简报。`;
  $('#library-document-list').innerHTML = libraryView.documents.length ? libraryView.documents.map(document => `<button class="library-document-item ${libraryView.selectedDocument?.id === document.id && libraryView.selectedResult === null ? 'selected' : ''}" data-library-document="${escape(document.id)}" aria-pressed="${libraryView.selectedDocument?.id === document.id && libraryView.selectedResult === null}"><h3>${escape(document.source.title)}</h3><p>${escape(document.company)} · ${escape(document.source.publisher || '来源未知')}</p><p>发布：${escape(document.source.date || '未知')} · 版本 ${document.version}</p><div class="tags"><span class="tag ${document.status === 'withdrawn' ? '' : 'green'}">${document.status === 'withdrawn' ? '已撤回' : '可检索'}</span>${document.issues?.length ? '<span class="tag orange">待核实</span>' : ''}</div></button>`).join('') : '<div class="empty-state"><h2>暂无库内资料</h2><p>在审核页将已纳入的原文保存到资料库，<br>或修改公司名称后重新查看。</p></div>';
  $('#library-results').innerHTML = libraryView.results.length ? libraryView.results.map((result, index) => `<div class="library-result-item ${libraryView.selectedResult === index ? 'selected' : ''}"><button class="library-result-preview" data-preview-library-result="${index}" aria-pressed="${libraryView.selectedResult === index}"><h3>${escape(result.title)}</h3><p>${escape(result.publisher || '来源未知')} · ${escape(result.date || '日期未知')} · 版本 ${result.version}</p><p class="library-result-excerpt">${escape(result.chunk.text.slice(0, 180))}${result.chunk.text.length > 180 ? '…' : ''}</p><span class="small muted">片段 ${escape(result.chunk.id)} · 查看片段与入库原文</span>${result.issues?.length ? '<span class="tag orange">待核实</span>' : ''}</button><button class="link-button" data-add-library-result="${index}" ${!resultCanAdd(result) || libraryView.adding.has(index) ? 'disabled' : ''}>${libraryView.adding.has(index) ? '正在加入…' : alreadyAdded(result) ? '已加入当前任务' : '加入任务待审核'}</button></div>`).join('') : '<div class="empty-state"><h2>暂无检索片段</h2><p>填写公司和关键词后检索。<br>没有匹配时可调整关键词、日期或待核实筛选。</p></div>';
  $$('[data-library-document]').forEach(button => button.addEventListener('click', () => selectLibraryDocument(button.dataset.libraryDocument)));
  $$('[data-preview-library-result]').forEach(button => button.addEventListener('click', () => { libraryView.selectedResult = Number(button.dataset.previewLibraryResult); libraryView.selectedDocument = null; renderLibrary(); }));
  $$('[data-add-library-result]').forEach(button => button.addEventListener('click', () => addLibraryResult(Number(button.dataset.addLibraryResult))));
  renderLibraryDetail();
}

function renderLibraryDetail() {
  const result = libraryView.selectedResult === null ? null : libraryView.results[libraryView.selectedResult];
  const document = result ? { id: result.documentId, company: result.company, version: result.version, source: result.source, issues: result.issues, updatedAt: result.archivedAt } : libraryView.selectedDocument;
  if (!document) {
    $('#library-document-detail').innerHTML = '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>选择资料，查看依据</h2><p>左侧查看库内资料或检索片段。<br>审核状态、来源和备注与原文一起保留。</p></div>';
    return;
  }
  const source = document.source;
  $('#library-document-detail').innerHTML = `<div class="detail-top"><span>${result ? '关键词匹配片段' : '入库原文快照'}</span><span>版本 ${document.version}${document.status === 'withdrawn' ? ' · 已撤回' : ''}</span></div><h2>${escape(source.title)}</h2><dl class="detail-facts"><div><dt>公司</dt><dd>${escape(document.company)}</dd></div><div><dt>资料发布日期</dt><dd>${escape(source.date || '未知')}</dd></div><div><dt>来源名称</dt><dd>${escape(source.publisher || '未知')}</dd></div><div><dt>入库更新时间</dt><dd>${escape(libraryDate(document.updatedAt))}</dd></div></dl><div class="source-link">${safeUrl(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">打开来源 ${icon('external')}</a><p>${escape(source.url)}</p>` : '本地资料 · 未提供外部链接'}</div>${source.file ? `<p class="local-file-note">${escape(localFileLabel(source))}</p><details class="local-file-note"><summary>文件指纹（SHA-256）</summary><p>${escape(source.file.sha256)}</p></details>` : ''}${source.web ? `<p class="local-file-note">DeepSeek Fetch · 原读取时间：${escape(libraryDate(source.web.fetchedAt))} · 原提取 ${source.web.originalChars} 字${source.web.truncated ? ' · 正文已截取' : ''}</p>` : ''}${document.issues?.length ? `<div class="issue-list">入库时核查提示：${document.issues.map(escape).join('；')}</div>` : ''}${source.note ? `<p class="source-check-note">入库核查备注：${escape(source.note)}</p>` : ''}${result ? `<div class="saved-text-title">检索片段（非全文） · 原文字符 ${result.chunk.start + 1}–${result.chunk.end}</div><div class="saved-text library-matched-text">${escape(result.chunk.text)}</div><details class="library-original-text"><summary>查看入库原文（${source.text.length} 字）</summary><div class="saved-text">${escape(source.text)}</div></details><div class="detail-actions"><button class="button secondary" data-add-library-result="${libraryView.selectedResult}" ${!resultCanAdd(result) || libraryView.adding.has(libraryView.selectedResult) ? 'disabled' : ''}>${alreadyAdded(result) ? '已加入当前任务' : libraryView.adding.has(libraryView.selectedResult) ? '正在加入…' : '加入任务待审核'}</button></div><p class="field-help library-source-note">仅加入当前片段；原文版本、位置与核查提示随引用保留。请检查上下文及指标口径。</p>` : `<div class="saved-text-title">入库时保存的正文（${source.text.length} 字）</div><div class="saved-text">${escape(source.text)}</div><div class="detail-actions">${document.status !== 'withdrawn' ? '<button id="withdraw-library-document" class="button secondary">从检索中撤回</button>' : '<p class="field-help">此资料已撤回，不会出现在新的检索结果中。已生成简报的来源快照仍保留。</p>'}</div><p class="field-help library-source-note">入库表示允许复用，不代表事实已被证明。更新正文或核查信息时，请从原资料重新审核并保存新版本。</p>`}<p class="library-record-id">资料库编号：${escape(document.id)}</p>`;
  $('#library-document-detail [data-add-library-result]')?.addEventListener('click', () => addLibraryResult(libraryView.selectedResult));
  $('#withdraw-library-document')?.addEventListener('click', () => confirmAction('从检索中撤回此资料？', '撤回后不再用于新的检索。原文记录与既有简报引用保留；已加入任务的片段请在任务中重新核查。', () => withdrawLibraryDocument(document), '确认撤回'));
}

async function loadLibraryDocuments() {
  const generation = libraryView.generation;
  const request = ++libraryView.listRequest;
  $('#library-status').textContent = '正在读取本机资料库…';
  $('#library-error').textContent = '';
  try {
    const company = $('#library-company').value.trim();
    const payload = await libraryRequest(`/api/library/documents${company ? `?company=${encodeURIComponent(company)}` : ''}`);
    if (!libraryCurrent(generation) || request !== libraryView.listRequest) return;
    libraryView.documents = payload.documents;
    if (libraryView.selectedDocument) libraryView.selectedDocument = payload.documents.find(item => item.id === libraryView.selectedDocument.id) || null;
    $('#library-status').textContent = `库内共 ${payload.documents.length} 条资料${company ? ` · 公司：${company}` : ''}。待核实资料默认不参与检索。`;
    renderLibrary();
  } catch (error) {
    if (libraryCurrent(generation) && request === libraryView.listRequest) { $('#library-status').textContent = '资料库暂时不可用，当前任务未改动。'; $('#library-error').textContent = error.message; }
  }
}

async function selectLibraryDocument(id) {
  const generation = libraryView.generation;
  const request = ++libraryView.listRequest;
  $('#library-error').textContent = '';
  try {
    const payload = await libraryRequest(`/api/library/documents/${encodeURIComponent(id)}`);
    if (!libraryCurrent(generation) || request !== libraryView.listRequest) return;
    libraryView.selectedDocument = payload.document;
    libraryView.selectedResult = null;
    renderLibrary();
  } catch (error) { if (libraryCurrent(generation) && request === libraryView.listRequest) $('#library-error').textContent = error.message; }
}

async function searchLibrary(event) {
  event.preventDefault();
  if (libraryView.busy) return;
  const query = $('#library-query').value.trim();
  const company = $('#library-company').value.trim();
  const start = $('#library-start').value;
  const end = $('#library-end').value;
  $('#library-error').textContent = '';
  if (!company || !query) { $('#library-error').textContent = '请填写公司名称和需要查找的关键词。'; return (!company ? $('#library-company') : $('#library-query')).focus(); }
  if ((start && !isDate(start)) || (end && !isDate(end)) || (start && end && start > end)) { $('#library-error').textContent = '请检查发布日期范围，起始日期不能晚于结束日期。'; return; }
  const generation = libraryView.generation;
  const taskId = state.task?.id;
  const request = ++libraryView.searchRequest;
  libraryView.busy = true;
  libraryView.results = [];
  libraryView.selectedResult = null;
  libraryView.adding.clear();
  $('#library-status').textContent = '正在按关键词检索已保存正文…';
  renderLibrary();
  try {
    const payload = await libraryPost('/api/library/search', { company, query, ...(start ? { start } : {}), ...(end ? { end } : {}), includeFlagged: $('#library-include-flagged').checked, limit: 8 });
    if (!libraryCurrent(generation) || taskId !== state.task?.id || request !== libraryView.searchRequest) return;
    libraryView.results = payload.results;
    libraryView.query = query;
    libraryView.panel = 'results';
    libraryView.selectedDocument = null;
    libraryView.selectedResult = payload.results.length ? 0 : null;
    $('#library-status').textContent = payload.results.length ? `找到 ${payload.results.length} 个相关片段 · 关键词检索；请结合入库原文核查上下文。` : '没有匹配片段。可调整关键词、发布日期或待核实筛选；系统不会补写缺失资料。';
  } catch (error) {
    if (libraryCurrent(generation) && request === libraryView.searchRequest) { $('#library-error').textContent = error.message; $('#library-status').textContent = '检索未完成，原有任务和资料未改动。'; }
  } finally {
    if (libraryCurrent(generation) && request === libraryView.searchRequest) { libraryView.busy = false; renderLibrary(); }
  }
}

async function addLibraryResult(index) {
  const result = libraryView.results[index];
  if (!result || libraryView.adding.has(index)) return;
  $('#library-error').textContent = '';
  if (!resultCanAdd(result)) { $('#library-error').textContent = alreadyAdded(result) ? '当前任务已有此版本的相同片段。' : state.sources.length >= MAX_SOURCES ? `单次研究最多 ${MAX_SOURCES} 条资料。` : '请先创建同公司的正式研究任务，再加入检索片段。'; return; }
  const generation = libraryView.generation;
  const taskId = state.task.id;
  const searchRequest = libraryView.searchRequest;
  const query = libraryView.query;
  libraryView.adding.add(index);
  renderLibrary();
  try {
    const payload = await libraryPost('/api/library/retrieve', { documentId: result.documentId, version: result.version, chunkId: result.chunk.id, query });
    if (!libraryCurrent(generation) || state.task?.id !== taskId || searchRequest !== libraryView.searchRequest) return;
    if (!resultCanAdd(payload.result)) throw new Error('任务已有此片段、公司不匹配或资料数量已达上限，请重新检查。');
    const source = libraryResultSource(payload.result, query);
    validateSources([...state.sources, source]);
    state.sources.push(source);
    selectedId = source.id;
    filter = 'all';
    invalidateReport(); persist();
    $('#library-status').textContent = '片段已加入当前任务，状态为待审核。返回工作台后核查并纳入。';
    toast('已加入任务待审核，尚未用于简报。');
  } catch (error) { if (libraryCurrent(generation) && state.task?.id === taskId && searchRequest === libraryView.searchRequest) $('#library-error').textContent = error.message; }
  finally { if (libraryCurrent(generation) && searchRequest === libraryView.searchRequest) { libraryView.adding.delete(index); renderLibrary(); } }
}

async function withdrawLibraryDocument(document) {
  const generation = libraryView.generation;
  $('#library-error').textContent = '';
  try {
    await libraryPost(`/api/library/documents/${encodeURIComponent(document.id)}/withdraw`, { version: document.version });
    if (!libraryCurrent(generation)) return;
    libraryView.results = libraryView.results.filter(item => item.documentId !== document.id);
    libraryView.selectedResult = null;
    await loadLibraryDocuments();
    if (libraryCurrent(generation)) toast('资料已从检索中撤回，原文记录与既有简报保留。');
  } catch (error) { if (libraryCurrent(generation)) $('#library-error').textContent = error.message; }
}

$('#open-library').addEventListener('click', () => openLibrary());
$('#search-library').addEventListener('click', () => openLibrary(true));
$('#close-library').addEventListener('click', closeLibrary);
$('#library-search-form').addEventListener('submit', searchLibrary);
$('#refresh-library-list').addEventListener('click', () => { libraryView.panel = 'documents'; libraryView.selectedResult = null; renderLibrary(); loadLibraryDocuments(); });
$('#library-documents-tab').addEventListener('click', () => { libraryView.panel = 'documents'; libraryView.selectedResult = null; renderLibrary(); });
$('#library-results-tab').addEventListener('click', () => { libraryView.panel = 'results'; libraryView.selectedDocument = null; libraryView.selectedResult = libraryView.results.length ? 0 : null; renderLibrary(); });
$('#view-library').addEventListener('keydown', event => { if (event.key === 'Escape' && !document.querySelector('dialog[open]')) { event.preventDefault(); closeLibrary(); } });

function updateReportHint() {
  const count = eligibleSources(state.sources).length;
  const modeHint = $('#report-mode').value === 'deepseek' ? '点击生成后会将纳入正文发送至 DeepSeek API，可能产生服务费用。' : '规则摘录不调用模型。';
  $('#report-hint').textContent = count ? `当前纳入 ${count} 条有正文的资料。${modeHint}` : '没有已纳入的可用正文，请返回审核并选择资料。';
}

function renderReport() {
  const report = state.report;
  $('#export-report').disabled = !report;
  $('#generate-report').disabled = !!requestController || !eligibleSources(state.sources).length;
  updateReportHint();
  if (!report) {
    $('#report-body').innerHTML = '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>尚未生成简报</h2><p>先纳入有正文的资料，再选择整理方式。<br>审核选择变更后，需要重新生成简报。</p></div>';
    return;
  }
  const citation = id => {
    const number = report.sources.find(source => source.id === id)?.sourceNumber;
    return `<a class="citation" href="#report-source-${number}" aria-label="查看来源 ${number}">[资料 ${number}]</a>`;
  };
  $('#report-body').innerHTML = `<div class="report-document"><div class="report-doc-header"><h2>${escape(report.task.company)}</h2><div class="doc-title">企业研究简报</div><p>研究范围：${report.task.start} — ${report.task.end}<br>关注主题：${escape(report.task.topic)}<br>生成方式：${report.mode === 'deepseek' ? 'DeepSeek 辅助整理 · 待人工核查' : '规则摘录 · 未调用模型'}<br>生成时间：${escape(new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false }))}</p></div><h3>主题概述</h3>${report.claims.map(claim => `<p class="claim">${escape(claim.text)} ${claim.sourceIds.map(citation).join('')}</p>${claimSourceWarnings(report, claim).length ? `<p class="claim-source-warning">${claimSourceWarnings(report, claim).map(escape).join('；')}。核查备注见对应引用来源。</p>` : ''}`).join('')}<h3>资料时间线 <span class="muted small">（按发布日期）</span></h3>${[...report.sources].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).map(source => `<div class="timeline-row"><span class="timeline-date">${source.date || '日期未知'}</span><div>${escape(source.title)} ${citation(source.id)}</div></div>`).join('')}<h3>信息缺口与待核实事项</h3><div class="report-gap"><ul>${report.gaps.map(gap => `<li>${escape(gap)}</li>`).join('')}</ul></div><h3>引用来源 <span class="muted small">（${report.sources.length} 条）</span></h3>${report.sources.map((source, index) => `<div id="report-source-${source.sourceNumber}" class="report-source" tabindex="-1"><strong>[资料 ${source.sourceNumber}] ${escape(source.title)}</strong><p>${escape(source.publisher || '来源未知')} · 发布：${source.date || '未知'} · 录入：${escape(source.collectedAt)}</p><p>${safeUrl(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : source.file ? '本地文件 · 未提供外部链接' : '无外部链接 · 虚构演示资料'}</p>${source.library ? `<p>资料库检索片段（非全文） · ${escape(librarySourceLabel(source))}</p><p>检索词：${escape(source.library.query)}<br>检索时间：${escape(libraryDate(source.library.retrievedAt))}</p>` : ''}${source.file ? `<p>${escape(localFileLabel(source))}</p>` : ''}${source.web ? `<p>DeepSeek Fetch · 读取：${escape(source.web.fetchedAt)} · 保存 ${source.text.length} / 提取 ${source.web.originalChars} 字${source.web.truncated ? ' · 正文已截取' : ''}</p>` : ''}${source.note ? `<p>核查备注：${escape(source.note)}</p>` : ''}<details><summary>查看纳入时保存的文本</summary><div class="saved-text">${escape(source.text)}</div></details></div>`).join('')}</div>`;
}

function releaseLocalFile() {
  fileGeneration++;
  if (fileLoadingTask) void fileLoadingTask.destroy().catch(() => {});
  fileLoadingTask = null;
  fileDocument = null;
  fileMetadata = null;
  fileBusy = false;
  rangeDirty = false;
}

function updateFileBusy(busy) {
  fileBusy = busy;
  $('#save-source').disabled = busy || (fileMode && (!fileMetadata || rangeDirty));
  $('#source-text').disabled = busy;
  $('#extract-pages').disabled = busy;
  $('#pdf-page-start').disabled = busy;
  $('#pdf-page-end').disabled = busy;
}

function openSourceDialog(localFile = false) {
  if (!state.task) return;
  if (state.sources.length >= MAX_SOURCES) return toast(`单次研究最多录入 ${MAX_SOURCES} 条资料`);
  releaseLocalFile();
  fileMode = localFile;
  $('#source-form').reset();
  $('#source-error').textContent = '';
  $('#source-dialog-title').textContent = localFile ? '导入本地资料' : '录入研究资料';
  $('#file-import-fields').hidden = !localFile;
  $('#pdf-page-controls').hidden = true;
  $('#source-url').required = !localFile;
  $('#source-url-required').hidden = localFile;
  $('#source-url-optional').hidden = !localFile;
  $('#import-progress').textContent = '';
  $('#import-warning').hidden = true;
  updateFileBusy(false);
  $('#source-dialog').showModal();
  $('#source-title').focus();
}

async function extractSelectedPages(generation) {
  const document = fileDocument;
  $('#source-error').textContent = '';
  let start = 1, end = document.totalPages;
  try {
    if (document.kind === 'pdf') {
      start = Number($('#pdf-page-start').value);
      end = Number($('#pdf-page-end').value);
      validatePageRange(start, end, document.totalPages);
    }
    updateFileBusy(true);
    const result = await extractLocalText(document, start, end, (page, last) => {
      if (generation === fileGeneration) $('#import-progress').textContent = `正在提取第 ${page} 页 / 所选末页 ${last}…`;
    });
    if (generation !== fileGeneration) return;
    const { name, size, sha256, kind, totalPages } = document;
    fileMetadata = { name, size, sha256, kind, extractedChars: result.extractedChars, truncated: result.truncated, ...(kind === 'pdf' ? { totalPages, pageStart: start, pageEnd: end } : {}) };
    rangeDirty = false;
    $('#source-text').value = result.text;
    $('#import-progress').textContent = `已提取 ${result.extractedChars.toLocaleString('zh-CN')} 字，保存前请核对正文。`;
    const warning = !result.text ? '没有提取到文字。扫描版 PDF 暂不支持文字识别；可手动粘贴正文，或取消并选择其他文件。' : result.truncated ? '正文超过 12,000 字，目前仅预填前 12,000 字。可缩小 PDF 页码范围重新提取，或手动选取内容；保存后会保留截取提示。' : '';
    $('#import-warning').textContent = warning;
    $('#import-warning').hidden = !warning;
  } catch (error) {
    if (generation === fileGeneration) {
      $('#source-error').textContent = error.message || '文件提取失败，请重新选择页码或手动录入';
      $('#import-progress').textContent = '未完成提取，未添加资料。';
    }
  } finally {
    if (generation === fileGeneration) updateFileBusy(false);
  }
}

$('#import-file-button').addEventListener('click', () => {
  if (!state.task || state.sources.length >= MAX_SOURCES) return toast(`单次研究最多录入 ${MAX_SOURCES} 条资料`);
  $('#source-file').value = '';
  $('#source-file').click();
});
$('#source-file').addEventListener('change', async event => {
  const file = event.currentTarget.files[0];
  if (!file) return;
  try { checkLocalFile(file); } catch (error) { toast(error.message); return; }
  openSourceDialog(true);
  const generation = fileGeneration;
  $('#source-title').value = file.name.replace(/\.(pdf|txt|md)$/i, '').slice(0, 200);
  const sizeLabel = file.size < 1024 * 1024 ? `${(file.size / 1024).toFixed(1)} KB` : `${(file.size / 1024 / 1024).toFixed(2)} MB`;
  $('#import-file-info').textContent = `${file.name} · ${sizeLabel}`;
  $('#import-progress').textContent = '正在读取文件…';
  updateFileBusy(true);
  try {
    const opened = await openLocalFile(file, loading => {
      if (generation === fileGeneration) fileLoadingTask = loading;
      else void loading.destroy();
    });
    if (generation !== fileGeneration) { await opened.pdf?.destroy(); return; }
    fileDocument = opened;
    if (opened.kind === 'pdf') {
      $('#import-file-info').textContent += ` · 共 ${opened.totalPages} 页`;
      $('#pdf-page-controls').hidden = false;
      for (const field of ['#pdf-page-start', '#pdf-page-end']) $(field).max = opened.totalPages;
      $('#pdf-page-start').value = 1;
      $('#pdf-page-end').value = opened.totalPages;
      if (opened.totalPages > MAX_PDF_PAGES) {
        rangeDirty = true;
        $('#import-progress').textContent = `共 ${opened.totalPages} 页，请选取不超过 ${MAX_PDF_PAGES} 页后提取。`;
        return;
      }
    }
    await extractSelectedPages(generation);
  } catch (error) {
    if (generation === fileGeneration) {
      $('#source-error').textContent = error.message || '无法读取文件，请重新选择或手动录入';
      $('#import-progress').textContent = '导入未完成，未添加资料。';
    }
  } finally {
    if (generation === fileGeneration) updateFileBusy(false);
  }
});
$('#extract-pages').addEventListener('click', () => { if (fileDocument && !fileBusy) void extractSelectedPages(fileGeneration); });
for (const input of ['#pdf-page-start', '#pdf-page-end']) $(input).addEventListener('input', () => {
  rangeDirty = true;
  $('#import-progress').textContent = '页码已修改，请点击“提取所选页”后保存。';
  updateFileBusy(false);
});
$('#source-dialog').addEventListener('close', () => { releaseLocalFile(); $('#source-file').value = ''; });

$('#task-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = Object.fromEntries(new FormData(event.currentTarget));
  input.company = input.company.trim(); input.topic = input.topic.trim();
  const errors = validateTask(input);
  for (const field of ['company', 'start', 'end', 'topic']) {
    $(`#${field}-error`).textContent = errors[field] || '';
    $(`#${field}`).setAttribute('aria-invalid', String(!!errors[field]));
  }
  if (Object.keys(errors).length) return $(`#${Object.keys(errors)[0]}`).focus();
  const next = { task: { ...input, id: crypto.randomUUID(), demo: false }, sources: [], report: null };
  const action = () => { replaceWorkspace(next, 'collect'); toast('任务已创建，可录入或导入资料'); };
  if (state.task) confirmAction('创建新任务？', '当前任务、资料和未导出的简报将被替换。需要保留的内容请先导出。', action, '创建并替换');
  else action();
});

function setDemoSidebarOpen(open, restoreFocus = true) {
  $('#demo-sidebar').hidden = !open;
  $('#toggle-demo-sidebar').setAttribute('aria-expanded', String(open));
  if (open) $('#close-demo-sidebar').focus({ preventScroll: true });
  else if (restoreFocus) $('#toggle-demo-sidebar').focus({ preventScroll: true });
}
$('#toggle-demo-sidebar').addEventListener('click', () => setDemoSidebarOpen($('#demo-sidebar').hidden));
$('#close-demo-sidebar').addEventListener('click', () => setDemoSidebarOpen(false));
$('#demo-sidebar').addEventListener('keydown', event => {
  if (event.key === 'Escape' && !document.querySelector('dialog[open]')) {
    event.preventDefault();
    setDemoSidebarOpen(false);
  }
});

$('#load-demo').addEventListener('click', () => {
  const action = () => { setDemoSidebarOpen(false, false); replaceWorkspace(demoWorkspace(), 'review'); toast('已载入 5 条虚构资料，请逐条审核'); };
  if (state.task) confirmAction('载入示例任务？', '这会替换当前任务和资料。示例中的公司、资料和事件均为虚构。', action, '载入示例');
  else action();
});

function clearWorkspace() {
  if (!state.task) return toast('当前工作台已经是空白状态');
  confirmAction('清空当前任务？', '当前任务、资料和简报将被清空。需要保留的内容请先导出。', () => {
    replaceWorkspace({ task: null, sources: [], report: null }, 'create');
    try { localStorage.removeItem(STORAGE_KEY); } catch { /* Warning already shown by persist. */ }
    toast('当前任务已清空');
  }, '确认清空');
}
$('#clear-workspace').addEventListener('click', clearWorkspace);

$('#confirm-cancel').addEventListener('click', () => $('#confirm-dialog').close());
$('#confirm-accept').addEventListener('click', () => { const action = pendingConfirmation; $('#confirm-dialog').close(); pendingConfirmation = null; action?.(); });
$('#confirm-dialog').addEventListener('close', () => { pendingConfirmation = null; });
$$('[data-close-dialog]').forEach(button => button.addEventListener('click', () => $('#source-dialog').close()));
$$('[data-step]').forEach(button => button.addEventListener('click', () => go(button.dataset.step)));
$$('[data-go]').forEach(button => button.addEventListener('click', () => go(button.dataset.go)));
$$('[data-filter]').forEach(button => button.addEventListener('click', () => { filter = button.dataset.filter; renderReview(); }));
$$('[data-topic]').forEach(button => button.addEventListener('click', () => {
  const input = $('#topic');
  if (!input.value.includes(button.dataset.topic)) input.value = input.value.trim() ? `${input.value.trim()}、${button.dataset.topic}` : button.dataset.topic;
  input.focus();
}));
document.addEventListener('click', event => { if (event.target.closest('[data-action="add-source"]')) openSourceDialog(); });

$('#source-form').addEventListener('submit', event => {
  event.preventDefault();
  if (fileBusy || (fileMode && (!fileMetadata || rangeDirty))) return;
  const input = Object.fromEntries(new FormData(event.currentTarget));
  for (const key of Object.keys(input)) input[key] = input[key].trim();
  let error = '';
  if (!input.title) error = '请填写资料标题';
  else if ((!fileMode || input.url) && !safeUrl(input.url)) error = '请填写有效的 HTTP 或 HTTPS 原文链接';
  else if (input.date && !isDate(input.date)) error = '发布时间无效；无法确认时请留空';
  else if (!input.text) error = '请粘贴可核查的原文片段';
  else if (state.sources.length >= MAX_SOURCES) error = `单次研究最多 ${MAX_SOURCES} 条资料`;
  if (error) { $('#source-error').textContent = error; return; }
  const source = { ...input, id: crypto.randomUUID(), collectedAt: new Date().toISOString(), review: 'pending', flagged: false, access: 'available', demo: false, note: '' };
  if (fileMode) {
    source.file = { ...fileMetadata };
    source.flagged = fileMetadata.truncated;
  }
  try { validateSources([...state.sources, source]); }
  catch { $('#source-error').textContent = '资料字段过长或格式无效，请检查后重试'; return; }
  state.sources.push(source);
  selectedId = source.id;
  invalidateReport(); persist();
  $('#source-dialog').close();
  if (currentStep === 'review') { filter = 'all'; renderReview(); }
  else renderCollection();
  toast('资料已保存，等待人工审核');
});

$('#report-mode').addEventListener('change', updateReportHint);

$('#generate-report').addEventListener('click', async () => {
  $('#report-error').textContent = '';
  try {
    if (!eligibleSources(state.sources).length) throw new Error('请先纳入至少一条有正文的资料');
    let claims = null;
    if ($('#report-mode').value === 'deepseek') {
      if (!modelAvailable) throw new Error('尚未配置 DeepSeek，请先使用规则摘录');
      const controller = new AbortController();
      requestController = controller;
      $('#generate-report').disabled = true;
      $('#generate-report').textContent = '正在整理…';
      $('#export-report').disabled = true;
      try {
        const response = await fetch('/api/report', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ task: state.task, sources: state.sources }), signal: controller.signal });
        const payload = await response.json();
        if (requestController !== controller) return;
        if (!response.ok) throw new Error(payload.error || '生成失败，请重试');
        claims = validateModelClaims(payload, state.sources);
      } catch (error) {
        if (controller.signal.aborted) return;
        throw error;
      } finally {
        if (requestController === controller) {
          requestController = null;
          $('#generate-report').disabled = !eligibleSources(state.sources).length;
          $('#generate-report').textContent = '生成简报';
          $('#export-report').disabled = !state.report;
        }
      }
    }
    state.report = createReport(state.task, state.sources, claims);
    renderReport();
    toast(claims ? '简报已整理，请结合原文核查模型结论' : '规则摘录已生成，未调用模型');
  } catch (error) { $('#report-error').textContent = error.message || '生成失败，审核结果已保留，请重试'; }
});

$('#export-report').addEventListener('click', () => {
  if (!state.report) return;
  const blob = new Blob([reportMarkdown(state.report)], { type: 'text/markdown;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `${state.task.company.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').slice(0, 60)}-${state.task.start}-${state.task.end}-简报.md`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  toast('已导出 Markdown 简报，包含引用与保存文本');
});

async function loadConfig() {
  try {
    const response = await fetch('/api/config');
    if (!response.ok) throw new Error('config unavailable');
    const config = await response.json();
    modelAvailable = config.modelAvailable === true;
    searchAvailable = config.searchAvailable === true && config.readerAvailable !== false;
    $('#model-status').textContent = modelAvailable ? `DeepSeek 已配置 · ${config.model}` : 'DeepSeek 未配置 · 可用规则摘录';
    const option = $('#report-mode option[value="deepseek"]');
    option.disabled = !modelAvailable;
    option.textContent = modelAvailable ? `DeepSeek · ${config.model}` : 'DeepSeek · 未配置';
  } catch { $('#model-status').textContent = '无法连接本地服务 · 请检查启动状态'; }
  updateResearchControls();
}

restore();
fillTaskForm();
go(state.task ? 'review' : 'create');
loadConfig();
