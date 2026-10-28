export const STORAGE_KEY = 'company-intelligence:current-task:v1';
export const MAX_SOURCES = 40;
export const MAX_TEXT = 12000;

export function validateTask(input) {
  const errors = {};
  if (!input.company?.trim()) errors.company = '请填写公司名称';
  if (!input.topic?.trim()) errors.topic = '请填写研究主题';
  if ((input.company || '').length > 100) errors.company = '公司名称最多 100 字';
  if ((input.topic || '').length > 200) errors.topic = '研究主题最多 200 字';
  if (!isDate(input.start)) errors.start = '请选择有效的起始日期';
  if (!isDate(input.end)) errors.end = '请选择有效的结束日期';
  if (!errors.start && !errors.end && input.end < input.start) errors.end = '结束日期不能早于起始日期';
  return errors;
}

export function isDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function safeUrl(value) {
  try {
    const url = new URL(value);
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

export function normalizeUrl(value) {
  const safe = safeUrl(value);
  if (!safe) return null;
  const url = new URL(safe);
  url.hash = '';
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  return url.href.replace(/\/$/, '');
}

export function sourceIssues(source, task, sources) {
  const issues = [];
  if (!source.date) issues.push('发布时间未知');
  else if (source.date < task.start || source.date > task.end) issues.push('发布时间超出研究范围');
  if (!source.text?.trim() || source.access !== 'available') issues.push('没有可用正文');
  const normalized = normalizeUrl(source.url);
  if (normalized && sources.some(item => item.id !== source.id && normalizeUrl(item.url) === normalized)) issues.push('URL 重复候选');
  if (source.flagged) issues.push('人工标记待核实');
  if (source.demo) issues.push('虚构演示资料');
  return issues;
}

export function eligibleSources(sources) {
  return sources.filter(source => source.review === 'included' && source.access === 'available' && source.text?.trim());
}

export function validateSources(sources) {
  if (!Array.isArray(sources) || sources.length > MAX_SOURCES) throw new Error(`资料数量不能超过 ${MAX_SOURCES} 条`);
  const ids = new Set();
  for (const source of sources) {
    if (!source || typeof source.id !== 'string' || !/^[a-zA-Z0-9-]{1,80}$/.test(source.id) || ids.has(source.id)) throw new Error('资料 ID 无效或重复');
    ids.add(source.id);
    if (typeof source.title !== 'string' || !source.title.trim() || source.title.length > 200) throw new Error('资料标题无效');
    if (typeof source.text !== 'string' || source.text.length > MAX_TEXT) throw new Error(`单条资料正文最多 ${MAX_TEXT} 字`);
    if (!['pending', 'included', 'excluded'].includes(source.review) || !['available', 'failed'].includes(source.access)) throw new Error('资料状态无效');
    if (source.date !== '' && !isDate(source.date)) throw new Error('资料日期无效');
    if (typeof source.publisher !== 'string' || source.publisher.length > 120) throw new Error('来源名称无效');
    if (source.url !== '' && !safeUrl(source.url)) throw new Error('资料链接必须是有效的 HTTP 或 HTTPS 地址');
    if (typeof source.flagged !== 'boolean' || typeof source.demo !== 'boolean') throw new Error('资料标记无效');
    if (!isDate(source.collectedAt?.slice(0, 10))) throw new Error('采集时间无效');
    if (typeof source.note !== 'string' || source.note.length > 500) throw new Error('资料备注无效');
  }
  return sources;
}

export function validateModelClaims(data, sources) {
  const ids = new Set(eligibleSources(sources).map(source => source.id));
  if (!Array.isArray(data?.claims) || !data.claims.length || data.claims.length > 15) throw new Error('模型未返回有效的结论列表，请重试');
  return data.claims.map(claim => {
    if (typeof claim.text !== 'string' || !claim.text.trim() || claim.text.length > 1200 || !Array.isArray(claim.sourceIds) || !claim.sourceIds.length || claim.sourceIds.some(id => !ids.has(id))) {
      throw new Error('模型返回了缺少有效来源的结论，报告未生成，请重试');
    }
    return { text: claim.text.trim(), sourceIds: [...new Set(claim.sourceIds)] };
  });
}

export function createReport(task, sources, claims = null) {
  const selected = eligibleSources(sources);
  if (!selected.length) throw new Error('请先纳入至少一条有正文的资料');
  const generatedAt = new Date().toISOString();
  const gaps = [
    '本次资料由用户手动录入或来自虚构演示，尚未执行真实联网搜索；不能判断检索覆盖情况。',
    '资料发布日期用于时间线，不等同于事件实际发生日期。公司与主题相关性需要人工核对。',
    '引用关联不代表结论已经得到验证；请结合原文复核。'
  ];
  if (selected.some(source => source.demo)) gaps.unshift('报告包含虚构演示资料，仅供操作体验，不可作为真实企业情报使用。');
  for (const source of selected) {
    const issues = sourceIssues(source, task, sources).filter(issue => issue !== '虚构演示资料');
    if (issues.length) gaps.push(`${source.title}：${issues.join('、')}。`);
  }
  const pending = sources.filter(source => source.review === 'pending').length;
  const failed = sources.filter(source => source.access !== 'available').length;
  if (pending) gaps.push(`另有 ${pending} 条资料尚未审核，未用于本报告。`);
  if (failed) gaps.push(`${failed} 条资料没有可用正文，未用于本报告。`);
  const snapshots = selected.map(source => ({ ...structuredClone(source), sourceNumber: sources.indexOf(source) + 1 }));
  return { generatedAt, mode: claims ? 'deepseek' : 'extract', task: { ...task }, sources: snapshots, claims: claims || selected.map(source => ({ text: source.text.trim().slice(0, 500), sourceIds: [source.id] })), gaps };
}

export function markdownText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\r?\n/g, '  \n');
}

export function reportMarkdown(report) {
  const md = markdownText;
  const number = id => report.sources.find(source => source.id === id)?.sourceNumber;
  const ref = id => `[来源 ${number(id)}](#source-${number(id)})`;
  const lines = [`# ${md(report.task.company)} · 企业研究简报`, '', `研究范围：${report.task.start} 至 ${report.task.end}`, `关注主题：${md(report.task.topic)}`, `生成时间：${report.generatedAt}`, `生成方式：${report.mode === 'deepseek' ? 'DeepSeek 辅助整理（待人工核查）' : '规则摘录（未调用模型）'}`, '', '## 主题概述', ''];
  for (const claim of report.claims) lines.push(`- ${md(claim.text)} ${claim.sourceIds.map(ref).join('、')}`);
  lines.push('', '## 资料时间线（按发布日期）', '');
  for (const source of [...report.sources].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))) lines.push(`- ${source.date || '日期未知'}：${md(source.title)} ${ref(source.id)}`);
  lines.push('', '## 信息缺口与待核实事项', '', ...report.gaps.map(gap => `- ${md(gap)}`), '', '## 引用来源', '');
  report.sources.forEach((source, index) => {
    lines.push(`<a id="source-${source.sourceNumber}"></a>`, `### 来源 ${source.sourceNumber}：${md(source.title)}`, '', `来源名称：${md(source.publisher || '未知')}  `, `发布时间：${source.date || '未知'}  `, `采集时间：${source.collectedAt}  `, `链接：${source.url ? `[打开原文](${encodeURI(source.url).replace(/\(/g, '%28').replace(/\)/g, '%29')})` : '无外部链接（虚构演示或手动录入）'}`, '', '保存文本：', '', ...source.text.split(/\r?\n/).map(line => `> ${md(line)}`), '');
  });
  return lines.join('\n');
}

export function demoWorkspace() {
  const task = { id: 'demo-task', company: '示例科技（虚构公司）', start: '2026-09-01', end: '2026-09-30', topic: '产品发布与业务合作', demo: true };
  const base = { publisher: '虚构演示资料', collectedAt: new Date().toISOString(), review: 'pending', flagged: false, access: 'available', demo: true, url: '', note: '' };
  const sources = [
    { id: 'demo-1', title: '示例科技发布企业协作产品 2.0', date: '2026-09-05', text: '【虚构演示】示例科技于 9 月 5 日发布企业协作产品 2.0，新增项目看板和资料归档功能。本段为自主编写的交互测试文本，不对应真实企业公告。' },
    { id: 'demo-2', title: '示例科技与示例制造开展试点合作', date: '2026-09-18', text: '【虚构演示】示例科技与示例制造签署试点合作意向，将在一条示范产线上测试资料协同流程。尚未披露合同金额及推广范围。本段不代表真实商业活动。' },
    { id: 'demo-3', title: '合作试点消息的补充报道', date: '', flagged: true, text: '【虚构演示】一则补充报道提及示例科技的合作试点，但未给出发布时间，也没有新的独立证据，需人工核查。本段为自主编写的测试文本。' },
    { id: 'demo-4', title: '上月产品预告（范围外样例）', date: '2026-08-20', text: '【虚构演示】示例科技发布产品预告。本资料发布日期不在本次研究范围内，用于测试范围提示。' },
    { id: 'demo-5', title: '无法读取的资料（失败样例）', date: '2026-09-22', text: '', access: 'failed', note: '演示读取失败：没有可用正文。原型未尝试联网读取。' }
  ].map(source => ({ ...base, ...source }));
  return { task, sources, report: null };
}
