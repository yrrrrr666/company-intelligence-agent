// UI regression fixture only. All upstream calls are intercepted; never uses a real key.
process.env.DEEPSEEK_API_KEY = 'test-only-placeholder';
process.env.PORT ||= '4176';
const attempts = new Map();
const text = '【自主编写的虚构回归资料】该条结论用于检查来源提示，不代表企业事实。2025年第一季度发布测试产品，时间和数据均为虚构。'.repeat(8);
globalThis.fetch = async (url, options) => {
  const input = JSON.parse(options.body);
  if (url === 'https://api.deepseek.com/v1/tools/search') {
    if (input.query.includes('空结果')) return Response.json({ results: [] });
    const paths = input.query.includes('停止') ? ['slow'] : ['ok', 'retry'];
    return Response.json({ results: paths.map(path => ({ title: `【虚构回归】${path} <script>不执行</script>`, url: `https://example.com/fixture-${path}`, site_name: '虚构测试来源', date: '2025-05-27T00:00:00Z', snippet: '这是搜索摘要，不是正文，也不能用于简报。' })) });
  }
  if (url === 'https://api.deepseek.com/v1/tools/fetch') {
    const count = (attempts.get(input.url) || 0) + 1;
    attempts.set(input.url, count);
    if (input.url.endsWith('retry') && count === 1) return new Response('private upstream error', { status: 404 });
    if (input.url.endsWith('slow')) await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 15000);
      options.signal.addEventListener('abort', () => { clearTimeout(timer); reject(options.signal.reason); }, { once: true });
    });
    return Response.json({ title: '【虚构回归】实际正文标题', content: text });
  }
  if (url === 'https://api.deepseek.com/chat/completions') {
    const sources = JSON.parse(input.messages[1].content).sources;
    return Response.json({ id: 'synthetic-provider-request', model: 'synthetic-model', usage: { prompt_tokens: 120, completion_tokens: 30, total_tokens: 150, prompt_cache_hit_tokens: 0 }, choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ claims: [{ text: '【虚构回归】该条结论用于检查来源提示，不代表企业事实。', sourceIds: [sources[0].id] }] }) } }] });
  }
  throw new Error('Fixture blocks every unexpected network call');
};
const { server } = await import('../src/server.mjs');
server.listen(Number(process.env.PORT), '127.0.0.1', () => console.log(`Synthetic research regression server: http://127.0.0.1:${server.address().port} (no real API calls)`));
