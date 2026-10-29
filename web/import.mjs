import { MAX_TEXT } from './core.mjs';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_PDF_PAGES = 100;

export function checkLocalFile(file) {
  if (!file || !/\.(pdf|txt|md)$/i.test(file.name || '')) throw new Error('请选择 PDF、TXT 或 Markdown（.md）文件');
  if (!Number.isSafeInteger(file.size) || file.size <= 0) throw new Error('文件为空，请选择包含正文的文件');
  if (file.size > MAX_FILE_BYTES) throw new Error('单个文件不能超过 10 MB，请拆分后再导入');
  if (file.name.length > 240) throw new Error('文件名过长，请缩短后再导入');
}

export function decodeLocalText(bytes) {
  let text;
  if (bytes[0] === 0xff && bytes[1] === 0xfe) text = new TextDecoder('utf-16le', { fatal: true }).decode(bytes);
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = new TextDecoder('utf-16be', { fatal: true }).decode(bytes);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { text = new TextDecoder('gb18030', { fatal: true }).decode(bytes); }
  }
  if (/[\u0000-\u0008\u000e-\u001f]/.test(text)) throw new Error('文件包含二进制内容，请使用纯文本 TXT 或 Markdown');
  return text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
}

export function prepareImportText(text) {
  const normalized = text.replace(/\r\n?/g, '\n').trim();
  return { text: normalized.slice(0, MAX_TEXT), extractedChars: normalized.length, truncated: normalized.length > MAX_TEXT };
}

export function validatePageRange(start, end, total) {
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 1 || end < start || end > total) throw new Error(`请填写 1 至 ${total} 之间的有效页码范围`);
  if (end - start + 1 > MAX_PDF_PAGES) throw new Error(`每次最多提取 ${MAX_PDF_PAGES} 页，请缩小页码范围`);
}

export async function openLocalFile(file, onLoadingTask = () => {}) {
  checkLocalFile(file);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  const sha256 = Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, '0')).join('');
  const kind = /\.pdf$/i.test(file.name) ? 'pdf' : 'text';
  const result = { name: file.name, size: file.size, sha256, kind };
  if (kind === 'text') return { ...result, content: decodeLocalText(bytes) };
  if (new TextDecoder().decode(bytes.slice(0, 5)) !== '%PDF-') throw new Error('文件内容不是有效 PDF，请检查文件格式');
  let pdfjs;
  try { pdfjs = await import('/vendor/pdfjs/pdf.mjs'); }
  catch { throw new Error('PDF 解析组件未加载，请先运行 npm install，再刷新页面重试'); }
  pdfjs.GlobalWorkerOptions.workerSrc = '/vendor/pdfjs/pdf.worker.mjs';
  const loading = pdfjs.getDocument({
    data: bytes, isEvalSupported: false, useWasm: false,
    cMapUrl: '/vendor/pdfjs/cmaps/', cMapPacked: true,
    standardFontDataUrl: '/vendor/pdfjs/standard_fonts/'
  });
  onLoadingTask(loading);
  let passwordProtected = false;
  loading.onPassword = () => { passwordProtected = true; void loading.destroy(); };
  try {
    const pdf = await loading.promise;
    return { ...result, pdf, totalPages: pdf.numPages };
  } catch {
    await loading.destroy();
    throw new Error(passwordProtected ? 'PDF 受密码保护，请先解密后再导入' : 'PDF 无法解析，文件可能已损坏；请换一个文件或手动录入文本');
  }
}

export async function extractLocalText(document, start = 1, end = document.totalPages, onProgress = () => {}) {
  if (document.kind === 'text') return prepareImportText(document.content);
  validatePageRange(start, end, document.totalPages);
  let text = '';
  for (let number = start; number <= end; number++) {
    onProgress(number, end);
    const page = await document.pdf.getPage(number);
    const content = await page.getTextContent();
    const body = content.items.filter(item => typeof item.str === 'string').map(item => item.str + (item.hasEOL ? '\n' : ' ')).join('').trim();
    if (body) text += `【PDF 第 ${number} 页】\n${body}\n\n`;
    page.cleanup();
    if (text.length > 500000) throw new Error('所选页提取文字超过 50 万字，请缩小页码范围');
  }
  return prepareImportText(text);
}
