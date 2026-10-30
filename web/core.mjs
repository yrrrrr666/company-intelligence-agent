import { retrievalPreview } from './retrieval.mjs';

export const STORAGE_KEY = 'company-intelligence:current-task:v1';
export const MAX_SOURCES = 40;
export const MAX_TEXT = 12000;

export function validateTask(input) {
  if (!input || typeof input !== 'object') input = {};
  const errors = {};
  if (typeof input.company !== 'string' || !input.company.trim()) errors.company = '请填写公司名称';
  if (typeof input.topic !== 'string' || !input.topic.trim()) errors.topic = '请填写研究主题';
  if (typeof input.company === 'string' && input.company.length > 100) errors.company = '公司名称最多 100 字';
  if (typeof input.topic === 'string' && input.topic.length > 200) errors.topic = '研究主题最多 200 字';
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

export function publicWebUrl(value) {
  const safe = typeof value === 'string' && value.length <= 2048 ? safeUrl(value) : null;
  if (!safe) return null;
  const url = new URL(safe);
  const host = url.hostname.replace(/\.$/, '');
  if (url.port || !host.includes('.') || /[:\[\]]/.test(host) || /^[\d.]+$/.test(host) || /(^|\.)(localhost|local|internal|lan|home|onion|test|invalid)$/.test(host)) return null;
  url.hash = '';
  return url.href;
}

export function researchQuery(task) {
  const boundary = (value, days) => {
    const date = new Date(`${value}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString().slice(0, 10);
  };
  const dates = ` after:${boundary(task.start, -1)} before:${boundary(task.end, 1)}`;
  const company = [...task.company.trim()].slice(0, 60).join('');
  const available = 128 - [...company + dates].length - 1;
  return `${company} ${[...task.topic.trim()].slice(0, Math.max(0, available)).join('')}${dates}`;
}

export function sourceIssues(source, task, sources) {
  const issues = [];
  if (!source.date) issues.push('发布时间未知');
  else if (source.date < task.start || source.date > task.end) issues.push('发布时间超出研究范围');
  if (!source.text?.trim() || source.access !== 'available') issues.push('没有可用正文');
  const normalized = normalizeUrl(source.url);
  const otherOrigin = item => item.id !== source.id && !(source.library && item.library?.documentId === source.library.documentId && item.library?.version === source.library.version);
  if (normalized && sources.some(item => otherOrigin(item) && normalizeUrl(item.url) === normalized)) issues.push('URL 重复候选');
  if (source.file && sources.some(item => otherOrigin(item) && item.file?.sha256 === source.file.sha256 && item.file.pageStart === source.file.pageStart && item.file.pageEnd === source.file.pageEnd)) issues.push('本地文件重复候选');
  if (source.file?.truncated) issues.push('文件文本已截取');
  if (source.web?.truncated) issues.push('网页正文已截取');
  if (source.web?.dateOrigin === 'search') issues.push('搜索提供的日期，待核实');
  if (source.flagged) issues.push('人工标记待核实');
  if (source.library) {
    const companyKey = value => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('zh-CN');
    if (companyKey(source.library.company) !== companyKey(task.company)) issues.push('资料库公司与当前研究公司不同');
    for (const issue of source.library.archivedIssues) issues.push(`入库时：${issue}`);
  }
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
    if (source.library !== undefined) {
      const library = source.library;
      const identifier = value => typeof value === 'string' && /^[a-zA-Z0-9-]{1,80}$/.test(value);
      if (!library || !identifier(library.documentId) || !identifier(library.chunkId) || !Number.isSafeInteger(library.version) || library.version < 1 || typeof library.company !== 'string' || !library.company.trim() || library.company.length > 100 || typeof library.query !== 'string' || !library.query.trim() || library.query.length > 200 || !isDate(library.retrievedAt?.slice(0, 10)) || !Number.isSafeInteger(library.start) || !Number.isSafeInteger(library.end) || !Number.isSafeInteger(library.originalLength) || library.start < 0 || library.end <= library.start || library.end > library.originalLength || library.originalLength > MAX_TEXT || library.end - library.start !== source.text.length || !Array.isArray(library.archivedIssues) || library.archivedIssues.length > 20 || library.archivedIssues.some(issue => typeof issue !== 'string' || !issue.trim() || issue.length > 200) || source.demo) throw new Error('资料库片段记录无效');
    }
    if (source.web !== undefined) {
      const web = source.web;
      if (!web || web.provider !== 'deepseek' || !['pending', 'available', 'failed'].includes(web.status) || !['search', 'reviewed', 'unknown'].includes(web.dateOrigin) || typeof web.query !== 'string' || [...web.query].length > 128 || typeof web.snippet !== 'string' || web.snippet.length > 600 || typeof web.error !== 'string' || web.error.length > 500 || typeof web.truncated !== 'boolean' || !Number.isSafeInteger(web.originalChars) || web.originalChars < 0 || web.originalChars > 2 * 1024 * 1024 || (web.fetchedAt !== '' && !isDate(web.fetchedAt?.slice(0, 10))) || !publicWebUrl(source.url) || (web.status === 'available') !== (source.access === 'available' && !!source.text.trim())) throw new Error('网页来源记录无效');
    }
    if (source.file !== undefined) {
      const file = source.file;
      if (!file || !['pdf', 'text'].includes(file.kind) || typeof file.name !== 'string' || !/^[^/\\\u0000-\u001f]{1,240}$/.test(file.name) || !Number.isSafeInteger(file.size) || file.size < 1 || file.size > 10 * 1024 * 1024 || typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !Number.isSafeInteger(file.extractedChars) || file.extractedChars < 0 || file.extractedChars > 10 * 1024 * 1024 || typeof file.truncated !== 'boolean') throw new Error('本地文件记录无效');
      if (file.kind === 'pdf' && (!Number.isSafeInteger(file.totalPages) || !Number.isSafeInteger(file.pageStart) || !Number.isSafeInteger(file.pageEnd) || file.pageStart < 1 || file.pageEnd < file.pageStart || file.pageEnd > file.totalPages || file.pageEnd - file.pageStart + 1 > 100)) throw new Error('PDF 页码记录无效');
    }
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
    selected.some(source => source.web) ? '本次包含自动收集的网页资料；搜索结果与读取结果有限，不能据此认定覆盖全部相关信息。' : '纳入资料来自手动录入、本地文件或虚构演示；本报告未使用自动收集的网页正文，不能判断检索覆盖情况。',
    '资料发布日期用于时间线，不等同于事件实际发生日期。公司与主题相关性需要人工核对。',
    '引用关联不代表结论已经得到验证；请结合原文复核。'
  ];
  if (selected.some(source => source.demo)) gaps.unshift('报告包含虚构演示资料，仅供操作体验，不可作为真实企业情报使用。');
  if (selected.some(source => source.file)) gaps.push('本地来源保留文件名、文件指纹、所选页码及保存文本；文本可能经过编辑，原文件请自行保管并核查。');
  if (selected.some(source => source.library)) gaps.push('本次包含资料库关键词检索片段，不代表原文全部内容或相关资料已完整覆盖；同一文档的多个片段不构成独立证据。片段保留检索时的版本快照，之后撤回或更新资料库不会改写已保存的研究依据。');
  for (const source of selected) {
    const issues = sourceIssues(source, task, sources).filter(issue => issue !== '虚构演示资料');
    if (issues.length) gaps.push(`${source.title}：${issues.join('、')}。`);
  }
  const pending = sources.filter(source => source.review === 'pending').length;
  const failed = sources.filter(source => source.access !== 'available').length;
  if (pending) gaps.push(`另有 ${pending} 条资料尚未审核，未用于本报告。`);
  if (failed) gaps.push(`${failed} 条资料没有可用正文，未用于本报告。`);
  const snapshots = selected.map(source => ({ ...structuredClone(source), sourceNumber: sources.indexOf(source) + 1 }));
  const reportClaims = (claims || selected.map(source => ({ text: source.library && source.text.length > 500 ? retrievalPreview(source.text, source.library.query, { maxLength: 480 }).text.trim() : source.text.trim().slice(0, 500), sourceIds: [source.id] }))).map(claim => ({ ...structuredClone(claim), sourceIds: [...claim.sourceIds] }));
  return { generatedAt, mode: claims ? 'deepseek' : 'extract', task: { ...task }, sources: snapshots, claims: reportClaims, gaps };
}

export function claimSourceWarnings(report, claim) {
  return report.sources.filter(source => claim.sourceIds.includes(source.id)).flatMap(source => {
    const issues = sourceIssues(source, report.task, report.sources).filter(issue => issue !== 'URL 重复候选' && issue !== '本地文件重复候选' && issue !== '虚构演示资料');
    return issues.length ? [`来源 ${source.sourceNumber} 待核实：${issues.join('、')}`] : source.note ? [`来源 ${source.sourceNumber} 有核查备注，请查阅来源详情`] : [];
  });
}

export function markdownText(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/([`*_{}\[\]<>#!|])/g, '\\$1').replace(/\r?\n/g, '  \n');
}

export function localFileLabel(source) {
  if (!source.file) return '';
  const file = source.file;
  return `本地文件：${file.name}${file.kind === 'pdf' ? ` · 第 ${file.pageStart}–${file.pageEnd} 页 / 共 ${file.totalPages} 页` : ''}${file.truncated ? ' · 文本已截取' : ''}`;
}

export function librarySourceLabel(source) {
  const library = source.library;
  if (!library) return '';
  return `资料库：${library.company} · 文档 ${library.documentId} · 版本 ${library.version} · 片段 ${library.chunkId} · 字符 ${library.start + 1}–${library.end} / ${library.originalLength}（检索片段，非全文；字符位置按保存文本计）`;
}

export function reportMarkdown(report) {
  const md = markdownText;
  const number = id => report.sources.find(source => source.id === id)?.sourceNumber;
  const ref = id => `[来源 ${number(id)}](#source-${number(id)})`;
  const lines = [`# ${md(report.task.company)} · 企业研究简报`, '', `研究范围：${report.task.start} 至 ${report.task.end}`, `关注主题：${md(report.task.topic)}`, `生成时间：${report.generatedAt}`, `生成方式：${report.mode === 'deepseek' ? 'DeepSeek 辅助整理（待人工核查）' : '规则摘录（未调用模型）'}`, '', '## 主题概述', ''];
  for (const claim of report.claims) {
    lines.push(`- ${md(claim.text)} ${claim.sourceIds.map(ref).join('、')}`);
    for (const warning of claimSourceWarnings(report, claim)) lines.push(`  - ${md(warning)}`);
  }
  lines.push('', '## 资料时间线（按发布日期）', '');
  for (const source of [...report.sources].sort((a, b) => (a.date || '9999').localeCompare(b.date || '9999'))) lines.push(`- ${source.date || '日期未知'}：${md(source.title)} ${ref(source.id)}`);
  lines.push('', '## 信息缺口与待核实事项', '', ...report.gaps.map(gap => `- ${md(gap)}`), '', '## 引用来源', '');
  report.sources.forEach((source, index) => {
    lines.push(`<a id="source-${source.sourceNumber}"></a>`, `### 来源 ${source.sourceNumber}：${md(source.title)}`, '', `来源名称：${md(source.publisher || '未知')}  `, `发布时间：${source.date || '未知'}  `, `采集时间：${source.collectedAt}  `, `链接：${source.url ? `[打开原文](${encodeURI(source.url).replace(/\(/g, '%28').replace(/\)/g, '%29')})` : source.file ? '本地文件，未提供外部链接' : '无外部链接（虚构演示或手动录入）'}`, ...(source.file ? [md(localFileLabel(source)), `SHA-256：${source.file.sha256}`, '保存文本可能经人工编辑，请核查原文件。'] : []), ...(source.note ? [`核查备注：${md(source.note)}`, ''] : []), '保存文本：', '', ...source.text.split(/\r?\n/).map(line => `> ${md(line)}`), '');
  });
  for (const source of report.sources.filter(source => source.web)) lines.push(`网页读取记录（来源 ${source.sourceNumber}）：DeepSeek Fetch；读取时间：${source.web.fetchedAt || '未读取'}；保存：${source.text.length} / 提取：${source.web.originalChars} 字${source.web.truncated ? '；正文已截取' : ''}；日期来源：${source.web.dateOrigin === 'reviewed' ? '人工确认' : source.web.dateOrigin === 'search' ? '搜索服务提供，待核实' : '未知'}。`, ...(source.web.query ? [`检索词：${md(source.web.query)}`] : []), '');
  for (const source of report.sources.filter(source => source.library)) lines.push(`资料库检索记录（来源 ${source.sourceNumber}）：${md(librarySourceLabel(source))}`, `检索词：${md(source.library.query)}  `, `检索时间：${source.library.retrievedAt}`, ...(source.library.archivedIssues.length ? [`入库时提示：${source.library.archivedIssues.map(md).join('；')}`] : []), '');
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
