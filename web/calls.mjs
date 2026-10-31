const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const operations = { search: '搜索资料', read: '读取网页', report: '生成简报' };
const statuses = { running: '进行中', succeeded: '成功', failed: '失败', cancelled: '已取消', interrupted: '未完成' };
const count = value => Number.isSafeInteger(value) && value >= 0 ? value.toLocaleString('zh-CN') : '未知';
const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('zh-CN', { hour12: false }) : '未知';
const duration = value => Number.isFinite(value) && value >= 0 ? value < 1000 ? `${value} 毫秒` : `${(value / 1000).toFixed(2)} 秒` : '未知';

function reason(code) {
  const known = {
    CLIENT_CANCELLED: '浏览器停止了请求；服务方仍可能计费，用量需核对。',
    SERVICE_RESTARTED: '服务重新启动，无法确认此前请求的最终结果；耗时与用量未知。',
    WEB_TIMEOUT: '资料服务请求超时。', WEB_CONNECTION_FAILED: '无法连接资料服务或读取响应。',
    WEB_INVALID_RESPONSE: '资料服务返回格式无效。', WEB_NO_CONTENT: '返回内容不足以作为可用正文。',
    WEB_RESPONSE_TOO_LARGE: '资料服务返回内容超过大小上限。',
    MODEL_TIMEOUT: '模型请求超时。', MODEL_CONNECTION_FAILED: '无法连接模型服务或读取响应。',
    MODEL_OUTPUT_LIMIT: '模型输出达到长度上限，未形成完整简报。', MODEL_EMPTY_CONTENT: '模型未返回简报正文。',
    MODEL_INVALID_JSON: '模型正文不是有效 JSON。', MODEL_INVALID_CLAIMS: '模型结论或引用未通过校验。'
  };
  if (known[code]) return known[code];
  const http = /^(?:MODEL|WEB)_HTTP_(\d{3})$/.exec(code || '');
  if (http?.[1] === '404' && code.startsWith('WEB_')) return '服务方未找到网页或无法读取正文，可核对链接或改用本地文件导入。';
  return http ? `服务方返回 HTTP ${http[1]}，请核对账户权限、余额或服务状态。` : code ? '本次请求未能完成，请结合错误编号核查。' : '无';
}

export function showCallLogWarning(payload) {
  if (typeof payload?.callLogWarning !== 'string') return;
  const node = document.querySelector('#call-log-warning');
  node.textContent = payload.callLogWarning;
  node.hidden = false;
}

export function initCallHistory({ getTask, getStep, go }) {
  const $ = selector => document.querySelector(selector);
  let previousStep = 'create';
  let records = [];
  let retained = 0;
  let limit = 500;
  let generation = 0;
  let controller;
  let loaded = false;

  function filtered() {
    return records.filter(record => (!$('#calls-operation').value || record.operation === $('#calls-operation').value) && (!$('#calls-status-filter').value || record.status === $('#calls-status-filter').value));
  }

  function render() {
    const visible = filtered();
    $('#export-calls').disabled = !loaded || !visible.length;
    $('#calls-summary').textContent = loaded ? `显示 ${visible.length} 条 · 本机保留 ${retained} / ${limit} 条；费用均待账单核对。` : '正在读取本机调用记录…';
    $('#calls-table-wrap').hidden = !visible.length;
    $('#calls-empty').hidden = !!visible.length || !loaded;
    $('#calls-rows').innerHTML = visible.map((record, index) => {
      const usage = record.usage || {};
      const field = (label, value) => `<div><dt>${label}</dt><dd>${escape(value ?? '未知')}</dd></div>`;
      const explanation = record.status === 'succeeded' ? '本次调用已完成。' : record.status === 'running' ? '请求尚未结束，刷新记录可查看最新状态。' : reason(record.errorCode);
      return `<tr><td>${escape(date(record.startedAt))}</td><td>${escape(operations[record.operation] || '未知操作')}<span class="call-secondary">${escape(record.model || (record.operation === 'report' ? '模型未知' : 'DeepSeek 工具'))}</span></td><td><span class="call-status call-${escape(record.status)}">${escape(statuses[record.status] || '未知')}</span></td><td>${escape(duration(record.durationMs))}</td><td>${count(usage.inputTokens)}</td><td>${count(usage.outputTokens)}</td><td>未知</td><td><button type="button" class="link-button call-detail-toggle" data-call-detail="${index}" aria-expanded="false" aria-controls="call-detail-${index}">查看详情</button></td></tr><tr id="call-detail-${index}" class="call-detail-row" hidden><td colspan="8"><p class="call-reason">${escape(explanation)}</p><dl class="call-fields">${field('调用 ID', record.id)}${field('研究任务 ID', record.taskId)}${field('资料 ID', record.sourceId)}${field('结束时间', record.finishedAt ? date(record.finishedAt) : record.status === 'running' ? '尚未结束' : '未知')}${field('服务方 HTTP 状态', record.httpStatus)}${field('服务方请求 ID', record.providerRequestId)}${field('总 token', count(usage.totalTokens))}${field('缓存命中输入 token', count(usage.cacheHitInputTokens))}${field('缓存未命中输入 token', count(usage.cacheMissInputTokens))}${field('错误编号', record.errorCode || '无')}</dl></td></tr>`;
    }).join('');
    for (const button of document.querySelectorAll('[data-call-detail]')) button.addEventListener('click', () => {
      const detail = $(`#call-detail-${button.dataset.callDetail}`);
      detail.hidden = !detail.hidden;
      button.setAttribute('aria-expanded', String(!detail.hidden));
      button.textContent = detail.hidden ? '查看详情' : '收起详情';
    });
  }

  async function load() {
    controller?.abort();
    controller = new AbortController();
    const request = ++generation;
    const taskId = $('#calls-current').checked ? getTask()?.id : undefined;
    loaded = false;
    records = [];
    $('#calls-error').textContent = '';
    $('#refresh-calls').disabled = true;
    $('#calls-table-wrap').hidden = true;
    render();
    try {
      const response = await fetch(`/api/calls${taskId ? `?taskId=${encodeURIComponent(taskId)}` : ''}`, { signal: controller.signal });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || '调用记录暂时不可用，请稍后刷新。');
      if (request !== generation || getStep() !== 'calls') return;
      records = payload.records;
      retained = payload.retained;
      limit = payload.limit;
      loaded = true;
      render();
    } catch (error) {
      if (request !== generation || getStep() !== 'calls' || error.name === 'AbortError') return;
      $('#calls-error').textContent = error.message || '无法读取调用记录，请检查本地服务后刷新。';
      $('#calls-summary').textContent = '调用记录未加载，当前研究资料未改动。';
    } finally { if (request === generation) $('#refresh-calls').disabled = false; }
  }

  $('#open-calls').addEventListener('click', () => {
    if (getStep() !== 'calls') previousStep = getStep();
    $('#calls-current').disabled = !getTask();
    $('#calls-current').checked = !!getTask();
    go('calls');
    void load();
  });
  $('#close-calls').addEventListener('click', () => {
    generation++;
    controller?.abort();
    go(getTask() ? previousStep : 'create');
    $('#open-calls').focus({ preventScroll: true });
  });
  $('#refresh-calls').addEventListener('click', () => { void load(); });
  $('#calls-current').addEventListener('change', () => { void load(); });
  for (const selector of ['#calls-operation', '#calls-status-filter']) $(selector).addEventListener('change', render);
  $('#export-calls').addEventListener('click', () => {
    if (!loaded || !filtered().length) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), costNote: '费用未知，需按供应商账单核对。仅包含当前筛选内已加载的调用记录。', records: filtered() }, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = '企业情报-调用记录.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
}
