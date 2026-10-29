import { publicWebUrl, isDate, MAX_TEXT } from '../web/core.mjs';

const BASE = 'https://api.deepseek.com/v1/tools/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
export const SEARCH_LIMIT = 5;

export class ResearchError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

async function requestTool(tool, input, key, signal) {
  const response = await fetch(`${BASE}${tool}`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(input), signal: AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])])
  });
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    const recovery = response.status === 401 ? '请检查本地密钥。' : response.status === 402 ? '账户余额不足，请检查服务账户。' : response.status === 429 ? '请求过于频繁，请稍后重试。' : response.status === 403 ? '服务拒绝访问该地址。' : response.status === 404 ? '页面不可用、受访问限制或没有可提取正文，可改用本地文件导入。' : '请稍后重试。';
    throw new ResearchError(`WEB_HTTP_${response.status}`, `${tool === 'search' ? '搜索' : '正文读取'}失败（HTTP ${response.status}）。${recovery}`);
  }
  const reader = response.body?.getReader();
  if (!reader) throw new ResearchError('WEB_INVALID_RESPONSE', '服务未返回可用内容，请重试。');
  let size = 0;
  const chunks = [];
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw new ResearchError('WEB_RESPONSE_TOO_LARGE', '服务返回内容过大，请缩小研究范围或导入相关文件页。');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ResearchError('WEB_INVALID_RESPONSE', '服务响应格式无效，请重试。'); }
}

const clip = (value, limit) => typeof value === 'string' ? value.trim().slice(0, limit) : '';

export async function searchWeb(query, { key, signal } = {}) {
  const payload = await requestTool('search', { query, count: SEARCH_LIMIT, need_content: false }, key, signal);
  if (!Array.isArray(payload?.results)) throw new ResearchError('WEB_INVALID_RESPONSE', '搜索响应缺少候选列表，请重试。');
  const candidates = [];
  const seen = new Set();
  for (const result of payload.results.slice(0, 50)) {
    const url = publicWebUrl(result?.url);
    if (!url || seen.has(url)) continue;
    seen.add(url);
    const date = typeof result.date === 'string' && isDate(result.date.slice(0, 10)) ? result.date.slice(0, 10) : '';
    const publisher = clip(result.site_name, 120);
    candidates.push({ title: clip(result.title, 200) || new URL(url).hostname, url, publisher: publisher && !/^(?:[a-f\d]{2}){4,}$/i.test(publisher) ? publisher : new URL(url).hostname, date, snippet: clip(result.snippet, 600) });
    if (candidates.length === SEARCH_LIMIT) break;
  }
  return candidates;
}

export async function readWebPage(url, { key, signal } = {}) {
  const publicUrl = publicWebUrl(url);
  if (!publicUrl) throw new ResearchError('WEB_INVALID_URL', '请使用公开网站的 HTTP 或 HTTPS 地址，不支持本机、内网、IP 地址或带登录信息的链接。');
  const payload = await requestTool('fetch', { url: publicUrl }, key, signal);
  if (typeof payload?.content !== 'string') throw new ResearchError('WEB_INVALID_RESPONSE', '服务未返回正文，请重试或导入本地文件。');
  const content = payload.content.replace(/\u0000/g, '').trim();
  if (content.length < 80) throw new ResearchError('WEB_NO_CONTENT', '返回内容过短，无法作为可用正文；请核对原文或导入本地文件。');
  return { title: clip(payload.title, 200), text: content.slice(0, MAX_TEXT), originalChars: content.length, truncated: content.length > MAX_TEXT, fetchedAt: new Date().toISOString() };
}
