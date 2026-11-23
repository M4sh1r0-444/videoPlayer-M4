/* 本地 OpenAI 兼容 mock 端点 —— 仅用于 AI 侧边栏（M7）验收测试，不参与打包
 * 用法: node scripts/mock-openai.js [port]
 * 行为:
 *  - Authorization: Bearer bad-key → 401（验证错误分类）
 *  - 非流式请求 → 完整 JSON（验证「测试连接」）
 *  - 流式请求 → 每 20ms 发 8 字节 delta（验证打字机与 SSE 解析）
 *  - 用户消息含 image_url → 回显图片大小与系统提示词开头（验证截图与上下文注入）
 */
const http = require('http');
const port = Number(process.argv[2]) || 18777;

http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => { body += d; });
  req.on('end', () => {
    if (req.headers.authorization === 'Bearer bad-key') {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { message: 'Incorrect API key provided' } }));
      return;
    }
    if (!req.url.includes('/chat/completions')) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end('{"error":{"message":"not found"}}');
      return;
    }
    let j = {};
    try { j = JSON.parse(body); } catch { /* 空 body */ }
    const msgs = j.messages || [];
    const sys = msgs.find((m) => m.role === 'system');
    const lastUser = [...msgs].reverse().find((m) => m.role === 'user');
    const parts = (lastUser && Array.isArray(lastUser.content)) ? lastUser.content : [];
    const hasImg = parts.some((c) => c.type === 'image_url');
    const userText = parts.find((c) => c.type === 'text');

    let reply;
    if (/arcsin|反三角/.test(JSON.stringify(msgs))) {
      // 模拟 DeepSeek 等模型的 \(..\) / \[..\] 定界符输出（v0.4.2 渲染管线回归用例）
      reply = '**反三角函数**是把三角函数限制在单调区间后取反函数得到的。\n\n常见四个：\n\n1. \\(y=\\arcsin x\\)\n   由 \\(y=\\sin x\\) 在 \\(\\left[-\\frac{\\pi}{2},\\frac{\\pi}{2}\\right]\\) 上取反函数。\n   \\[\n   \\arcsin x+\\arccos x=\\frac{\\pi}{2},\\qquad x\\in[-1,1]\n   \\]\n\n2. \\(y=\\arccos x\\)\n   定义域 \\([-1,1]\\)，值域 \\([0,\\pi]\\)，单调递减。';
    } else if (hasImg) {
      const img = parts.find((c) => c.type === 'image_url');
      const b64 = ((img.image_url && img.image_url.url) || '').split(',')[1] || '';
      reply = `已收到截图（约 ${Math.round((b64.length * 3) / 4 / 1024)} KB）。` +
        `系统提示词开头：${sys ? sys.content.slice(0, 60) : '（无）'}…\n\n你的问题是：${userText ? userText.text : '（无文字）'}`;
    } else if (/积分|∫/.test(JSON.stringify(msgs))) {
      reply = '计算定积分：\n\n$$\\int_0^1 x^2\\,dx = \\left[ \\frac{x^3}{3} \\right]_0^1 = \\frac{1}{3}$$\n\n也就是 **1/3**。行内写法 $x^2$ 也能渲染。';
    } else {
      reply = '这是一条 **Markdown** 回复：\n\n- 列表项 1\n- 列表项 2\n\n`inline code` 与代码块：\n\n```js\nconsole.log("hello");\n```\n\n> 引用一行\n\n系统提示词开头：' + (sys ? sys.content.slice(0, 60) : '（无）') + '…';
    }

    if (j.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      const chunks = reply.match(/[\s\S]{1,8}/g) || [];
      let i = 0;
      const timer = setInterval(() => {
        if (i >= chunks.length) {
          clearInterval(timer);
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        res.write('data: ' + JSON.stringify({ choices: [{ delta: { content: chunks[i++] } }] }) + '\n\n');
      }, 20);
      // 注意:不能用 req.on('close')（Node 中请求流读完即触发，会误清定时器）
      res.on('close', () => clearInterval(timer));
    } else {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        id: 'mock', object: 'chat.completion', model: j.model || 'mock-model',
        choices: [{ message: { role: 'assistant', content: reply } }],
        usage: { total_tokens: 8 },
      }));
    }
  });
}).listen(port, () => console.log('mock openai listening on http://127.0.0.1:' + port + '/v1'));
