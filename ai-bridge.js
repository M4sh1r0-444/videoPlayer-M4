/* AI 侧边栏主进程桥（M7）
 * - 网络全部走主进程 net 模块（CSP 不放宽、Key 不进渲染层网络栈、自动感知系统代理）
 * - SSE 流式解析按字节找 \n 分行（UTF-8 多字节字符不会在行内被切断）
 * - ai-history.json 独立于 learn.json，防对话膨胀拖累 300ms 整体落盘
 * - 截帧复用 ffmpeg；非 playable 源自动改用 remux 缓存 mp4
 */
const { ipcMain, net, app } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

let ctx = null; // { getWin, getStore, ff: { findFfTools, remuxState } }
let current = null; // { requestId, request, aborting, started }
let reqSeq = 0;

function emit(win, channel, payload) {
  try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch { /* 窗口已关 */ }
}

function chatUrl(cfg) {
  return String(cfg.baseUrl || '').trim().replace(/\/+$/, '') + '/chat/completions';
}

// 错误分类（中文提示；任何分支都不回显 apiKey）
function classifyHttpError(status, body) {
  const b = String(body || '').slice(0, 200);
  if (status === 401 || status === 403) return { ok: false, message: `API Key 无效或无权限（HTTP ${status}），请检查 Key 是否正确、是否有余额` };
  if (status === 404) return { ok: false, message: `接口地址不存在（HTTP 404），请检查 BaseURL（通常以 /v1 结尾，不要带 /chat/completions）` };
  if (status === 429) return { ok: false, message: '请求过于频繁或额度不足（HTTP 429），稍后再试' };
  if (status >= 500) return { ok: false, message: `服务端错误（HTTP ${status}），服务商暂时不可用` };
  if (status === 400 && /image|vision|multimodal|图片/i.test(b)) {
    return { ok: false, message: '当前模型可能不支持图片输入，请换用多模态模型或去掉截图重试' };
  }
  return { ok: false, message: `请求失败（HTTP ${status}）：${b || '无响应体'}` };
}

function classifyNetError(err) {
  const m = String(err && err.message || err);
  if (/ERR_NAME_NOT_RESOLVED/.test(m)) return { ok: false, message: '域名解析失败，请检查接口地址是否写错' };
  if (/ERR_ADDRESS_UNREACHABLE|ERR_CONNECTION_REFUSED|ERR_TIMED_OUT/.test(m)) {
    return { ok: false, message: '无法连接到服务器，请检查地址/端口（本地服务需正在运行）或代理设置' };
  }
  if (/ERR_INTERNET_DISCONNECTED|ERR_NETWORK_CHANGED|ERR_PROXY/.test(m)) {
    return { ok: false, message: '网络连接失败，请检查网络或系统代理设置' };
  }
  if (/ERR_ABORTED/.test(m)) return { ok: false, message: '已中断' };
  return { ok: false, message: `网络错误：${m.slice(0, 120)}` };
}

/* ---------------- 流式对话 ---------------- */

function abortCurrent(win, reason) {
  if (!current) return;
  const req = current.request;
  req.__aborted = true; // 供 error 事件区分主动中断与网络错误
  try { req.abort(); } catch { /* 已结束 */ }
  current = null;
  if (reason) emit(win, 'ai:error', { requestId: reason.requestId, message: reason.message });
}

function sendChat(requestId, cfg, messages, win) {
  const url = chatUrl(cfg);
  let req;
  try {
    req = net.request({ url, method: 'POST' });
  } catch {
    emit(win, 'ai:error', { requestId, message: '接口地址格式无效，请检查 BaseURL' });
    return;
  }
  current = { requestId, request: req, aborting: false, started: false };

  req.setHeader('Content-Type', 'application/json');
  req.setHeader('Authorization', 'Bearer ' + (cfg.apiKey || ''));
  req.write(JSON.stringify({ model: cfg.model || '', messages, stream: true }));

  let content = '';
  let firstByte = true;
  let firstByteTimer = setTimeout(() => abortCurrent(win, { requestId, message: '等待响应超时（60 秒无首字节），已中断' }), 60 * 1000);
  const hardLimit = setTimeout(() => abortCurrent(win, { requestId, message: '响应超过 5 分钟上限，已中断' }), 5 * 60 * 1000);

  const cleanup = () => { clearTimeout(firstByteTimer); clearTimeout(hardLimit); if (current && current.request === req) current = null; };

  req.on('response', (res) => {
    const status = res.statusCode;
    let errBody = '';
    res.on('data', (d) => {
      if (status !== 200) { errBody += d.toString('utf8').slice(0, 2000); return; }
      if (firstByte) { firstByte = false; clearTimeout(firstByteTimer); }
      content += consumeSse(res, d, (delta) => emit(win, 'ai:chunk', { requestId, delta }));
    });
    res.on('end', () => {
      cleanup();
      if (status !== 200) { emit(win, 'ai:error', { requestId, message: classifyHttpError(status, errBody).message }); return; }
      emit(win, 'ai:done', { requestId, content });
    });
    res.on('error', (err) => { cleanup(); emit(win, 'ai:error', { requestId, ...classifyNetError(err) }); });
  });

  req.on('error', (err) => {
    cleanup();
    if (req.__aborted) return; // 主动中断，ai:error 已另行通知
    emit(win, 'ai:error', { requestId, ...classifyNetError(err) });
  });

  req.end();
}

// SSE 增量解析：res 上挂行缓冲，返回本次新增的明文 delta
// 注：跨 chunk 的多字节字符按行隔离天然安全（\n 是单字节且不出现在多字节序列中）
const sseBuf = Symbol('sseBuf');
function consumeSse(res, chunk, onDelta) {
  let buf = res[sseBuf] || Buffer.alloc(0);
  buf = Buffer.concat([buf, chunk]);
  let out = '';
  let idx;
  while ((idx = buf.indexOf(0x0a)) >= 0) {
    const line = buf.slice(0, idx).toString('utf8').trim();
    buf = buf.slice(idx + 1);
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') continue;
    try {
      const j = JSON.parse(payload);
      const delta = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
      if (typeof delta === 'string') out += delta;
    } catch { /* 中转站脏行丢弃不中断 */ }
  }
  res[sseBuf] = buf;
  if (out) onDelta(out);
  return out;
}

/* ---------------- 截帧（ffmpeg → JPEG base64） ---------------- */

function captureFrame(filePath, position) {
  return new Promise((resolve) => {
    const tools = ctx.ff.findFfTools();
    if (!tools) return resolve({ dataUrl: null, error: '未检测到 ffmpeg，无法截图' });
    let src = filePath;
    // MKV/FLV 等非 playable 源：优先用已有的 remux 缓存 mp4 抽帧
    const rs = ctx.ff.remuxState.get(filePath);
    if (rs && rs.status === 'ready' && rs.file && fs.existsSync(rs.file)) src = rs.file;
    const pos = Math.max(0, Number(position) || 0).toFixed(2);
    let child;
    try {
      child = spawn(tools.ffmpeg,
        ['-ss', pos, '-i', src, '-frames:v', '1', '-vf', 'scale=1280:-2', '-q:v', '5', '-f', 'image2', 'pipe:1'],
        { windowsHide: true });
    } catch { return resolve({ dataUrl: null, error: 'ffmpeg 启动失败' }); }
    const parts = [];
    let done = false;
    const finish = (val) => { if (!done) { done = true; resolve(val); } };
    child.stdout.on('data', (d) => parts.push(d));
    child.stderr.on('data', () => {});
    child.on('error', () => finish({ dataUrl: null, error: 'ffmpeg 启动失败' }));
    child.on('close', () => {
      const buf = Buffer.concat(parts);
      // JPEG 魔数 FFD8 校验，防把错误文本当图片
      if (buf.length > 100 && buf[0] === 0xff && buf[1] === 0xd8) {
        finish({ dataUrl: 'data:image/jpeg;base64,' + buf.toString('base64') });
      } else {
        finish({ dataUrl: null, error: '截图失败（该时间点可能无画面）' });
      }
    });
    setTimeout(() => { try { child.kill(); } catch {} finish({ dataUrl: null, error: '截图超时' }); }, 12000);
  });
}

/* ---------------- 历史文件代理（ai-history.json） ---------------- */

const HIST_MAX = 200;

function histFile() { return path.join(app.getPath('userData'), 'ai-history.json'); }

function histLoad() {
  try {
    const data = JSON.parse(fs.readFileSync(histFile(), 'utf8'));
    return { messages: Array.isArray(data.messages) ? data.messages.slice(-HIST_MAX) : [] };
  } catch { return { messages: [] }; }
}

let histTimer = null;
function histSaveSoon(data) {
  clearTimeout(histTimer);
  histTimer = setTimeout(() => {
    try {
      // 上限 200 条，超出从最旧处整对丢弃（避免开头悬一条 assistant）
      let m = (data.messages || []).slice();
      while (m.length > HIST_MAX) {
        m.shift();
        if (m.length && m[0].role === 'assistant') m.shift();
      }
      fs.writeFileSync(histFile(), JSON.stringify({ messages: m, updatedAt: new Date().toISOString() }, null, 2));
    } catch (err) { console.error('AI 历史保存失败:', err && err.message); }
  }, 300);
}

/* ---------------- IPC 注册 ---------------- */

function registerAiIpc(deps) {
  ctx = deps;

  ipcMain.handle('ai-save-config', (_e, cfg) => {
    const store = ctx.getStore();
    if (!store) return false;
    store.ai = {
      baseUrl: String(cfg?.baseUrl || ''),
      apiKey: String(cfg?.apiKey || ''),
      model: String(cfg?.model || ''),
      contextEnabled: cfg?.contextEnabled !== false,
      systemPrompt: String(cfg?.systemPrompt || ''),
    };
    ctx.saveStore(); // 复用 main.js 的 300ms 防抖落盘，渲染层一次调用完成保存
    return true;
  });

  ipcMain.handle('ai-test', async () => {
    const cfg = ctx.getStore()?.ai || {};
    if (!String(cfg.baseUrl || '').trim()) return { ok: false, message: '请先填写接口地址' };
    return new Promise((resolve) => {
      let req;
      try { req = net.request({ url: chatUrl(cfg), method: 'POST' }); }
      catch { return resolve({ ok: false, message: '接口地址格式无效' }); }
      req.setHeader('Content-Type', 'application/json');
      req.setHeader('Authorization', 'Bearer ' + (cfg.apiKey || ''));
      req.write(JSON.stringify({ model: cfg.model || '', messages: [{ role: 'user', content: 'ping' }], max_tokens: 8, stream: false }));
      let body = '';
      const timer = setTimeout(() => { try { req.abort(); } catch {} resolve({ ok: false, message: '连接超时（30 秒），请检查地址与网络' }); }, 30 * 1000);
      req.on('response', (res) => {
        res.on('data', (d) => { body += d.toString('utf8'); if (body.length > 65536) { try { req.abort(); } catch {} } });
        res.on('end', () => {
          clearTimeout(timer);
          if (res.statusCode !== 200) return resolve(classifyHttpError(res.statusCode, body));
          try {
            const j = JSON.parse(body);
            const model = j.model || cfg.model || '';
            const usage = j.usage && j.usage.total_tokens != null ? ` · 用时正常` : '';
            resolve({ ok: true, message: `连接成功${model ? `（${model}）` : ''}${usage}` });
          } catch { resolve({ ok: false, message: '响应不是合法 JSON，该地址可能不是 OpenAI 兼容接口' }); }
        });
        res.on('error', () => { clearTimeout(timer); resolve({ ok: false, message: '连接中断' }); });
      });
      req.on('error', (err) => { clearTimeout(timer); resolve(classifyNetError(err)); });
      req.end();
    });
  });

  ipcMain.handle('ai-send', async (_e, arg) => {
    const win = ctx.getWin();
    const cfg = ctx.getStore()?.ai || {};
    if (!String(cfg.baseUrl || '').trim()) return { ok: false, error: '尚未配置 AI 接口，请到「设置 → AI 助手」填写' };
    abortCurrent(win); // 单在途：新请求自动中断旧请求
    const requestId = ++reqSeq;
    sendChat(requestId, cfg, arg && arg.messages, win);
    return { ok: true, requestId };
  });

  ipcMain.handle('ai-abort', async () => {
    const win = ctx.getWin();
    if (current) abortCurrent(win, { requestId: current.requestId, message: '已停止' });
    return true;
  });

  ipcMain.handle('ai-history-load', () => histLoad());
  ipcMain.handle('ai-history-save', (_e, data) => { histSaveSoon(data || { messages: [] }); return true; });
  ipcMain.handle('ai-history-clear', () => {
    clearTimeout(histTimer);
    try { fs.unlinkSync(histFile()); } catch { /* 本就不存在 */ }
    return true;
  });

  ipcMain.handle('ai-capture-frame', async (_e, arg) => {
    const { path: file, position } = arg || {};
    if (!file || !fs.existsSync(file)) return { dataUrl: null, error: '视频文件不存在' };
    return captureFrame(file, position);
  });
}

module.exports = { registerAiIpc };
