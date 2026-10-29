import { STORAGE_KEY, MAX_SOURCES, validateTask, isDate, safeUrl, sourceIssues, eligibleSources, validateSources, validateModelClaims, createReport, reportMarkdown, demoWorkspace, localFileLabel } from './core.mjs';
import { checkLocalFile, openLocalFile, extractLocalText, validatePageRange, MAX_PDF_PAGES } from './import.mjs';

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
  if (!state.task && step !== 'create') return;
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
  $('#main').focus({ preventScroll: true });
  window.scrollTo(0, 0);
}

function renderCollection() {
  const task = state.task;
  const queries = [`"${task.company}" ${task.topic}`, `"${task.company}" 公告 ${task.start} ${task.end}`, `"${task.company}" ${task.topic} 官方`];
  $('#queries').innerHTML = queries.map((query, index) => `<div class="query-row"><code>${escape(query)}</code><button class="copy-query" data-copy-query="${index}" aria-label="复制第 ${index + 1} 条检索词">复制</button></div>`).join('');
  $$('[data-copy-query]').forEach(button => button.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(queries[Number(button.dataset.copyQuery)]); toast('检索词已复制'); }
    catch { toast('无法复制，请选中检索词手动复制'); }
  }));
  $('#collect-count').innerHTML = `${state.sources.length} <small>条资料</small>`;
  $('#collect-summary').textContent = `${state.sources.filter(source => source.access === 'available' && source.text.trim()).length} 条有保存文本，${state.sources.filter(source => source.access !== 'available').length} 条无可用正文。`;
  $('#source-count').textContent = `共 ${state.sources.length} 条 / 上限 ${MAX_SOURCES} 条`;
  $('#collection-list').innerHTML = state.sources.length ? state.sources.map(source => `<div class="collection-row"><div><strong>${escape(source.title)}</strong><p>${escape(source.publisher || '来源未知')}，${escape(source.date || '发布时间未知')}，${source.access === 'available' ? (source.file ? '本地导入文本' : '已保存文本') : '无可用正文'}${source.demo ? '（虚构演示）' : ''}</p></div><button class="link-button" data-open-source="${escape(source.id)}">查看资料</button></div>`).join('') : '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>还没有研究资料</h2><p>录入资料或导入本地文件，再进入人工审核。</p><button class="button secondary" data-action="add-source">录入第一条资料</button></div>';
  $$('[data-open-source]').forEach(button => button.addEventListener('click', () => { selectedId = button.dataset.openSource; filter = 'all'; go('review'); }));
}

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
  $('#source-detail').innerHTML = `<div class="detail-top"><span>资料 ${state.sources.indexOf(source) + 1}</span><span>${escape(reviewLabel(source))}</span></div>
    <h2>${escape(source.title)}</h2>
    <dl class="detail-facts"><div><dt>来源名称</dt><dd>${escape(source.publisher || '未知')}</dd></div><div><dt>发布时间</dt><dd>${escape(source.date || '未知')}</dd></div><div><dt>录入时间</dt><dd>${escape(new Date(source.collectedAt).toLocaleString('zh-CN', { hour12: false }))}</dd></div><div><dt>资料状态</dt><dd>${source.access === 'available' ? (source.file ? '本地文件文本，可经人工编辑' : '已录入文本，未联网读取') : '无可用正文（失败演示）'}</dd></div></dl>
    <div class="source-link">${safeUrl(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">打开来源 ${icon('external')}</a><p class="muted small">${escape(source.url)}</p>` : source.file ? '本地文件 · 未提供外部链接' : '无外部链接（虚构演示资料）'}</div>
    ${issues.length ? `<div class="issue-list">核查提示：${issues.map(escape).join('；')}</div>` : ''}
    ${source.file ? `<p class="local-file-note">${escape(localFileLabel(source))}</p><details class="local-file-note"><summary>文件指纹（SHA-256）</summary><p>${escape(source.file.sha256)}</p></details>` : ''}<div class="saved-text-title">保存文本</div><div class="saved-text">${escape(source.text || source.note || '没有可用正文，无法纳入报告。')}</div>
    <div class="detail-actions"><button class="button include" id="include-source" ${!source.text.trim() || source.access !== 'available' ? 'disabled' : ''}>${icon('check')}${source.review === 'included' ? '已纳入简报' : '纳入简报'}</button><button class="button secondary" id="exclude-source">${source.review === 'excluded' ? '已排除' : '排除此资料'}</button></div>
    <div class="detail-foot"><label class="flag-label"><input id="flag-source" type="checkbox" ${source.flagged ? 'checked' : ''}> 标记待核实</label>${source.review !== 'pending' ? '<button id="reset-review" class="link-button">撤销审核</button>' : ''}</div>`;
  $('#include-source').addEventListener('click', () => reviewSource(source.id, 'included'));
  $('#exclude-source').addEventListener('click', () => reviewSource(source.id, 'excluded'));
  $('#reset-review')?.addEventListener('click', () => reviewSource(source.id, 'pending'));
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

function renderReport() {
  const report = state.report;
  $('#export-report').disabled = !report;
  $('#generate-report').disabled = !!requestController || !eligibleSources(state.sources).length;
  $('#report-hint').textContent = eligibleSources(state.sources).length ? `当前纳入 ${eligibleSources(state.sources).length} 条有正文的资料。规则摘录不调用模型。` : '没有已纳入的可用正文，请返回审核并选择资料。';
  if (!report) {
    $('#report-body').innerHTML = '<div class="empty-state"><svg class="empty-icon" aria-hidden="true"><use href="#i-file"/></svg><h2>尚未生成简报</h2><p>先纳入有正文的资料，再选择整理方式。<br>审核选择变更后，需要重新生成简报。</p></div>';
    return;
  }
  const citation = id => {
    const number = report.sources.find(source => source.id === id)?.sourceNumber;
    return `<a class="citation" href="#report-source-${number}" aria-label="查看来源 ${number}">[资料 ${number}]</a>`;
  };
  $('#report-body').innerHTML = `<div class="report-document"><div class="report-doc-header"><h2>${escape(report.task.company)}</h2><div class="doc-title">企业研究简报</div><p>研究范围：${report.task.start} — ${report.task.end}<br>关注主题：${escape(report.task.topic)}<br>生成方式：${report.mode === 'deepseek' ? 'DeepSeek 辅助整理 · 待人工核查' : '规则摘录 · 未调用模型'}<br>生成时间：${escape(new Date(report.generatedAt).toLocaleString('zh-CN', { hour12: false }))}</p></div><h3>主题概述</h3>${report.claims.map(claim => `<p class="claim">${escape(claim.text)} ${claim.sourceIds.map(citation).join('')}</p>`).join('')}<h3>资料时间线 <span class="muted small">（按发布日期）</span></h3>${[...report.sources].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999')).map(source => `<div class="timeline-row"><span class="timeline-date">${source.date || '日期未知'}</span><div>${escape(source.title)} ${citation(source.id)}</div></div>`).join('')}<h3>信息缺口与待核实事项</h3><div class="report-gap"><ul>${report.gaps.map(gap => `<li>${escape(gap)}</li>`).join('')}</ul></div><h3>引用来源 <span class="muted small">（${report.sources.length} 条）</span></h3>${report.sources.map((source, index) => `<div id="report-source-${source.sourceNumber}" class="report-source" tabindex="-1"><strong>[资料 ${source.sourceNumber}] ${escape(source.title)}</strong><p>${escape(source.publisher || '来源未知')} · 发布：${source.date || '未知'} · 录入：${escape(source.collectedAt)}</p><p>${safeUrl(source.url) ? `<a href="${escape(source.url)}" target="_blank" rel="noopener noreferrer">打开原文</a>` : source.file ? '本地文件 · 未提供外部链接' : '无外部链接 · 虚构演示资料'}</p>${source.file ? `<p>${escape(localFileLabel(source))}</p>` : ''}<details><summary>查看纳入时保存的文本</summary><div class="saved-text">${escape(source.text)}</div></details></div>`).join('')}</div>`;
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

$('#report-mode').addEventListener('change', () => {
  $('#report-hint').textContent = $('#report-mode').value === 'deepseek' ? '点击生成后，将把已纳入的资料正文发送至 DeepSeek API，可能产生服务费用。' : '规则摘录保留来源文本，不调用模型。';
});

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
    $('#model-status').textContent = modelAvailable ? `DeepSeek 已配置 · ${config.model}` : 'DeepSeek 未配置 · 可用规则摘录';
    const option = $('#report-mode option[value="deepseek"]');
    option.disabled = !modelAvailable;
    option.textContent = modelAvailable ? `DeepSeek · ${config.model}` : 'DeepSeek · 未配置';
  } catch { $('#model-status').textContent = '无法连接本地服务 · 请检查启动状态'; }
}

restore();
fillTaskForm();
go(state.task ? 'review' : 'create');
loadConfig();
