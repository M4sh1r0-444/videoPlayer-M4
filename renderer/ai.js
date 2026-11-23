/* AI 提问侧边栏（M7）· 渲染层全部逻辑
 * 依赖 renderer.js 的全局词法声明：state / video / esc / fmtTime / showToast / $
 * 依赖 vendor：marked / DOMPurify / katex
 * CSP 约束：不碰 el.style.*（一律 class 切换）；图片用 data: URL（CSP 已加 data:）
 */

const AI = {
  cfg: null,            // store.ai 引用
  messages: [],         // 会话历史 [{role, content, ts, imgAt?, __img?(仅当条,发送后即清)}]
  streaming: false,
  streamBuf: '',
  streamEl: null,       // 流式中的 AI 气泡 DOM
  requestId: null,
  pendingImage: null,   // {dataUrl, at} 待随下条消息发送的截图
  unsub: null,
};
window.AI = AI; // 挂到 window 便于外部诊断（CDP/DevTools）

/* ---------- Markdown + KaTeX 占位符渲染管线 ----------
 * 占位符用 PUA 区字符 \uE000/\uE001 包裹（HTML 解析器不会把它转成 U+FFFD，
 * marked/DOMPurify 均原样保留），防 marked 吃掉 LaTeX 的 _ * 等语法。
 * 顺序：代码占位 → 公式占位 → marked → 代码回填 → DOMPurify → KaTeX 回填
 * （KaTeX trust:false 默认禁 \href 等，输出可信，放在 sanitize 之后不引入风险） */

const PH_L = '\uE000', PH_R = '\uE001';

// 聊天场景：单换行也断行（AI 常一段多行输出）
try { marked.setOptions({ breaks: true, gfm: true }); } catch { /* 老 marked 兼容 */ }

function stashPlaceholders(text) {
  const codeSlots = [];
  const kSlots = [];
  const pushK = (tex, display) => { kSlots.push({ tex: tex.trim(), display }); return `${PH_L}K${kSlots.length - 1}${PH_R}`; };
  let s = String(text ?? '');
  s = s.replace(/```[\s\S]*?(?:```|$)|`[^`\n]*`/g, (m) => `${PH_L}C${codeSlots.push(m) - 1}${PH_R}`);
  // 定界符四种写法都吃：$$..$$ 与 \(..\)\[..\] 是模型常见输出（DeepSeek 等爱用反斜杠括号），$..$ 兜底
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => pushK(tex, true));
  s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => pushK(tex, true));
  s = s.replace(/\\begin\{(equation\*?|align\*?)\}([\s\S]+?)\\end\{\1\}/g, (_, _env, tex) => pushK(tex, true));
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => pushK(tex, false));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, tex) => pushK(tex, false));
  return { s, codeSlots, kSlots };
}

function codeToHtml(raw) {
  if (raw.startsWith('```')) {
    let body = raw.slice(3).replace(/```$/, '');
    const nl = body.indexOf('\n'); // 首行是 ```lang 标注
    if (nl >= 0) body = body.slice(nl + 1);
    return '<pre><code>' + esc(body.replace(/\s+$/, '')) + '</code></pre>';
  }
  return '<code>' + esc(raw.slice(1, -1)) + '</code>';
}

function katexToHtml(slot) {
  try {
    return katex.renderToString(slot.tex, { displayMode: slot.display, throwOnError: false, strict: 'ignore' });
  } catch {
    return '<code>' + esc(slot.tex) + '</code>';
  }
}

function renderRich(text) {
  // P4：优先走共享管线（style 暂存为 data-vds-style，插入后再 CSSOM 回填，避免 CSP 违规）；
  // 旧内联管线保留为 UI 未就绪时的兜底。
  if (window.UI && typeof window.UI.renderRich === 'function') return window.UI.renderRich(text);
  const { s, codeSlots, kSlots } = stashPlaceholders(text);
  let html;
  try { html = marked.parse(s); } catch { html = '<p>' + esc(s) + '</p>'; }
  html = html.replace(new RegExp(`${PH_L}C(\\d+)${PH_R}`, 'g'), (_, i) => codeToHtml(codeSlots[+i]));
  html = DOMPurify.sanitize(html);
  html = html.replace(new RegExp(`${PH_L}K(\\d+)${PH_R}`, 'g'), (_, i) => katexToHtml(kSlots[+i]));
  return html;
}

// 插入富文本后回填 KaTeX 的样式；UI 不可用时退化为普通 innerHTML
function renderInto(el, text) {
  el.innerHTML = renderRich(text);
  if (window.UI && typeof window.UI.applyRichStyles === 'function') window.UI.applyRichStyles(el);
}

/* ---------- 上下文注入 ---------- */

function buildSystemPrompt() {
  let base = '你是一位耐心的学习辅导老师，擅长把复杂概念讲得清晰易懂。';
  if (AI.cfg?.contextEnabled !== false && state.course && state.index >= 0 && state.course.episodes[state.index]) {
    const ep = state.course.episodes[state.index];
    const pos = Number.isFinite(video.currentTime) ? fmtTime(video.currentTime) : '00:00';
    const dur = Number.isFinite(video.duration) ? fmtTime(video.duration) : '未知时长';
    base += `用户正在学习《${state.course.name}》（科目：${state.subject ? state.subject.name : ''}），当前观看分集《${ep.title}》（第 ${state.index + 1} 集，播放位置 ${pos}/${dur}）。`;
  }
  base += '用中文简洁准确地回答，数学公式使用 LaTeX（行内 $...$，独立公式 $$...$$）。';
  if (AI.cfg?.systemPrompt) base += '\n' + AI.cfg.systemPrompt;
  return base;
}

// 回传 API：system + 最近 20 条；旧截图只发文字（省 token），本次截图消息带 image_url
function buildApiMessages() {
  const out = [{ role: 'system', content: buildSystemPrompt() }];
  for (const m of AI.messages.slice(-20)) {
    if (m.__img) {
      out.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: m.__img } },
          { type: 'text', text: m.__apiText || m.content },
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

/* ---------- 消息渲染 ---------- */

function aiScrollBottom() { const box = $('aiMsgs'); if (box) box.scrollTop = box.scrollHeight; }

function msgEl(m, { error = false, raw = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg ' + (m.role === 'user' ? 'user' : 'assistant') + (error ? ' error' : '');
  const role = document.createElement('div');
  role.className = 'ai-role';
  role.textContent = m.role === 'user' ? '我' : error ? '出错了' : 'AI';
  const bubble = document.createElement('div');
  bubble.className = 'ai-bubble';
  if (m.imgAt) {
    const tag = document.createElement('div');
    tag.className = 'ai-imgtag';
    tag.textContent = `📷 画面时间点 ${m.imgAt}`;
    bubble.appendChild(tag);
  }
  const body = document.createElement('div');
  body.className = 'ai-content';
  if (m.role === 'assistant' && !raw && !error) renderInto(body, m.content);
  else body.textContent = m.content;
  bubble.appendChild(body);
  wrap.appendChild(role);
  wrap.appendChild(bubble);
  return wrap;
}

function welcomeCardEl() {
  const wrap = document.createElement('div');
  wrap.className = 'ai-msg assistant';
  const b = document.createElement('div');
  b.className = 'ai-bubble ai-welcome';
  b.innerHTML = '首次使用请先配置 AI 接口：<b>设置 → AI 助手</b><br>' +
    '支持 DeepSeek / Kimi / 智谱 GLM / OpenAI / Ollama 本地及各类中转站（OpenAI 兼容协议）。<br>' +
    '配置后即可流式问答（Markdown 与 LaTeX 公式渲染），播放中可点 📷 截图提问。';
  const btn = document.createElement('button');
  btn.className = 'mini-btn';
  btn.textContent = '去设置';
  btn.onclick = () => { $('btnSettings').click(); };
  b.appendChild(document.createElement('br'));
  b.appendChild(btn);
  wrap.appendChild(b);
  return wrap;
}

function renderAiMsgs() {
  if (AI.streaming) return; // 流式中不重建列表（streamEl 会失效）
  const box = $('aiMsgs');
  box.innerHTML = '';
  if (!AI.cfg || !AI.cfg.baseUrl) { box.appendChild(welcomeCardEl()); return; }
  if (!AI.messages.length) {
    const tip = document.createElement('div');
    tip.className = 'ai-welcome';
    tip.textContent = '问点什么吧，例如：这一节的难点是什么？和上一节有什么联系？';
    box.appendChild(tip);
    return;
  }
  for (const m of AI.messages) box.appendChild(msgEl(m));
  aiScrollBottom();
}

/* ---------- 历史持久化（图片 base64 不落盘） ---------- */

function saveHistory() {
  window.api.aiHistorySave({
    messages: AI.messages.map((m) => {
      const o = { role: m.role, content: m.content, ts: m.ts };
      if (m.imgAt) o.imgAt = m.imgAt;
      return o;
    }),
  });
}

/* ---------- 发送 / 流式状态机 ---------- */

function setStreaming(on) {
  AI.streaming = on;
  const btn = $('aiSend');
  btn.textContent = on ? '停止' : '发送';
  btn.classList.toggle('streaming', on);
}

function appendStreamBubble() {
  AI.streamBuf = '';
  AI.streamEl = msgEl({ role: 'assistant', content: '' }, { raw: true });
  const body = AI.streamEl.querySelector('.ai-content');
  body.classList.add('ai-cursor');
  $('aiMsgs').appendChild(AI.streamEl);
  aiScrollBottom();
}

function removeStreamBubble() {
  if (AI.streamEl) { AI.streamEl.remove(); AI.streamEl = null; }
}

function appendError(text) {
  $('aiMsgs').appendChild(msgEl({ role: 'assistant', content: text }, { error: true }));
  aiScrollBottom();
}

function finishStreamAsPartial() {
  // 出错/中断时已收到的部分内容保留为回答（不丢用户已读信息）
  if (AI.streamEl && AI.streamBuf.trim()) {
    renderInto(AI.streamEl.querySelector('.ai-content'), AI.streamBuf + '\n\n*（回答被中断）*');
    AI.messages.push({ role: 'assistant', content: AI.streamBuf + '\n\n（回答被中断）', ts: new Date().toISOString() });
    saveHistory();
  }
  removeStreamBubble();
}

async function doSend() {
  if (AI.streaming) { window.api.aiAbort(); return; }
  const input = $('aiInput');
  const q = input.value.trim();
  const img = AI.pendingImage;
  if (!q && !img) return;
  if (!AI.cfg || !AI.cfg.baseUrl) {
    showToast('请先在「设置 → AI 助手」配置接口');
    $('btnSettings').click();
    return;
  }

  const userMsg = { role: 'user', content: q || '（截图提问）', ts: new Date().toISOString() };
  if (img) {
    userMsg.imgAt = img.at;
    userMsg.__img = img.dataUrl;     // 仅本次发送携带，落盘前剔除
    userMsg.__apiText = q ? `${q}（画面时间点 ${img.at}）` : `请讲解画面中的内容（画面时间点 ${img.at}）`;
  }
  AI.messages.push(userMsg);
  input.value = '';
  clearPendingImage();
  if (!$('aiPanel').classList.contains('hidden')) {
    $('aiMsgs').appendChild(msgEl(userMsg));
    aiScrollBottom();
  }
  saveHistory();

  setStreaming(true);
  appendStreamBubble();
  try {
    const r = await window.api.aiSend(buildApiMessages());
    // 无论成败，图片只随本条发一次（旧截图不重发）
    delete userMsg.__img;
    delete userMsg.__apiText;
    if (!r.ok) {
      removeStreamBubble();
      setStreaming(false);
      appendError(r.error || '发送失败');
      return;
    }
    AI.requestId = r.requestId;
  } catch (e) {
    delete userMsg.__img;
    delete userMsg.__apiText;
    removeStreamBubble();
    setStreaming(false);
    appendError('发送失败：' + (e && e.message ? e.message : e));
  }
}

function onAiEvent(arg) {
  if (!arg || arg.requestId !== AI.requestId) return; // 只处理最新请求的事件
  if (arg.delta != null) {
    AI.streamBuf += arg.delta;
    if (AI.streamEl) AI.streamEl.querySelector('.ai-content').textContent = AI.streamBuf;
    aiScrollBottom();
  } else if (arg.content != null) { // done
    if (AI.streamEl) {
      const body = AI.streamEl.querySelector('.ai-content');
      body.classList.remove('ai-cursor');
      renderInto(body, arg.content);
    }
    AI.messages.push({ role: 'assistant', content: arg.content, ts: new Date().toISOString() });
    setStreaming(false);
    removeStreamBubble();
    if (!$('aiPanel').classList.contains('hidden')) {
      $('aiMsgs').appendChild(msgEl(AI.messages[AI.messages.length - 1]));
      aiScrollBottom();
    }
    saveHistory();
  } else if (arg.message) { // error / 中断
    finishStreamAsPartial();
    setStreaming(false);
    appendError(arg.message);
  }
}

/* ---------- 截图提问 ---------- */

function showShotBar() {
  let bar = $('aiShotBar');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'aiShotBar';
    bar.innerHTML = '<img alt="截图预览"><span class="grow"></span><button aria-label="取消截图" title="取消截图">✕</button>';
    bar.querySelector('button').onclick = () => clearPendingImage();
    $('aiInputBar').parentNode.insertBefore(bar, $('aiInputBar'));
  }
  const img = bar.querySelector('img');
  img.src = AI.pendingImage.dataUrl;
  bar.querySelector('.grow').textContent = `已截取 ${AI.pendingImage.at} 的画面，将随下条提问发送`;
  bar.classList.remove('hidden');
  $('aiShot').classList.add('pending');
}

function clearPendingImage() {
  AI.pendingImage = null;
  const bar = $('aiShotBar');
  if (bar) {
    bar.querySelector('img').removeAttribute('src');
    bar.classList.add('hidden');
  }
  $('aiShot').classList.remove('pending');
}

$('aiShot').onclick = async () => {
  if (!state.course || state.index < 0 || !state.course.episodes[state.index]) {
    showToast('先播放一个视频，再截图提问');
    return;
  }
  showToast('正在截取画面…');
  const ep = state.course.episodes[state.index];
  const at = Number.isFinite(video.currentTime) ? fmtTime(video.currentTime) : '00:00';
  const r = await window.api.aiCaptureFrame(ep.path, video.currentTime);
  if (r && r.dataUrl) {
    AI.pendingImage = { dataUrl: r.dataUrl, at };
    showShotBar();
    $('aiInput').focus();
  } else {
    showToast((r && r.error) || '截图失败');
  }
};

/* ---------- 面板开关 / 快捷键 / chips ---------- */

function toggleAIPanel() {
  const p = $('aiPanel');
  const opening = p.classList.contains('hidden');
  p.classList.toggle('hidden');
  $('btnAI').classList.toggle('on', opening);
  if (opening) {
    renderAiMsgs();
    $('aiInput').focus();
  } else {
    $('aiInput').blur(); // 收回焦点，空格/方向键交还播放器
  }
}
window.toggleAI = toggleAIPanel; // 供 renderer.js 的 Ctrl+I 处理器调用

// 全屏播放时隐藏侧栏（CSS :has 规则为主，此处兜底 fullscreenchange）
let aiOpenBeforeFs = false;
document.addEventListener('fullscreenchange', () => {
  const p = $('aiPanel');
  if (document.fullscreenElement) {
    aiOpenBeforeFs = !p.classList.contains('hidden');
    p.classList.add('hidden');
    $('btnAI').classList.remove('on');
  } else if (aiOpenBeforeFs) {
    p.classList.remove('hidden');
    $('btnAI').classList.add('on');
  }
});

$('btnAI').onclick = toggleAIPanel;
$('aiClose').onclick = () => {
  $('aiPanel').classList.add('hidden');
  $('btnAI').classList.remove('on');
  $('aiInput').blur();
};
$('aiSend').onclick = doSend;
$('aiInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); doSend(); }
});
document.querySelectorAll('.ai-chip').forEach((b) => {
  b.onclick = () => { $('aiInput').value = b.textContent; $('aiInput').focus(); };
});

$('aiClear').onclick = () => {
  if (!AI.messages.length) return;
  if (!window.confirm('确定清空全部对话记录？此操作不可恢复。')) return;
  AI.messages = [];
  window.api.aiHistoryClear();
  renderAiMsgs();
  showToast('对话已清空');
};

function updateCtxChip() {
  $('aiCtxChip').textContent = '上下文：' + (AI.cfg && AI.cfg.contextEnabled !== false ? '开' : '关');
}
$('aiCtxChip').onclick = () => {
  AI.cfg.contextEnabled = AI.cfg.contextEnabled === false;
  updateCtxChip();
  state.store.ai = AI.cfg;
  window.api.aiSaveConfig(AI.cfg);
};

/* ---------- 设置页：预设 / 表单 / 测试连接 ---------- */

const AI_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
};

function renderAiSettings() {
  $('aiPreset').value = '';
  $('aiBaseUrl').value = AI.cfg?.baseUrl || '';
  $('aiApiKey').value = AI.cfg?.apiKey || '';
  $('aiModel').value = AI.cfg?.model || '';
  $('aiSysPrompt').value = AI.cfg?.systemPrompt || '';
  $('aiTestMsg').textContent = '';
  $('aiTestMsg').className = 'ai-test-msg';
}

function saveAiForm() {
  AI.cfg = {
    baseUrl: $('aiBaseUrl').value.trim(),
    apiKey: $('aiApiKey').value.trim(),
    model: $('aiModel').value.trim(),
    contextEnabled: AI.cfg ? AI.cfg.contextEnabled !== false : true,
    systemPrompt: $('aiSysPrompt').value,
  };
  state.store.ai = AI.cfg;
  window.api.aiSaveConfig(AI.cfg); // 主进程内存 + 300ms 防抖落盘
  updateCtxChip();
}

// 挂在 renderer.js 原设置按钮之后（ai.js 后加载，可安全包装）
{
  const prevOpen = $('btnSettings').onclick;
  $('btnSettings').onclick = () => { if (prevOpen) prevOpen(); renderAiSettings(); };
}

$('aiPreset').addEventListener('change', () => {
  const p = AI_PRESETS[$('aiPreset').value];
  if (!p) return;
  $('aiBaseUrl').value = p.baseUrl;
  $('aiModel').value = p.model;
  saveAiForm();
});
for (const id of ['aiBaseUrl', 'aiApiKey', 'aiModel', 'aiSysPrompt']) {
  $(id).addEventListener('change', saveAiForm);
}

$('aiTestBtn').onclick = async () => {
  saveAiForm();
  const msg = $('aiTestMsg');
  msg.textContent = '正在连接…';
  msg.className = 'ai-test-msg';
  let r;
  try { r = await window.api.aiTest(); }
  catch (e) { r = { ok: false, message: '调用失败：' + (e && e.message ? e.message : e) }; }
  msg.textContent = r ? r.message : '调用失败';
  msg.className = 'ai-test-msg ' + (r && r.ok ? 'ok' : 'bad');
};

/* ---------- 启动 ---------- */

(async function aiBoot() {
  // 等待 renderer.js 的 boot() 拉到 store（同页脚本共享全局词法环境）
  for (let i = 0; i < 200 && !state.store; i++) await new Promise((r) => setTimeout(r, 25));
  if (!state.store) return;
  AI.cfg = state.store.ai = state.store.ai || { baseUrl: '', apiKey: '', model: '', contextEnabled: true, systemPrompt: '' };
  try {
    const hist = await window.api.aiHistoryLoad();
    AI.messages = (hist && hist.messages) || [];
  } catch { AI.messages = []; }
  AI.unsub = window.api.onAiEvent(onAiEvent);
  updateCtxChip();
  renderAiMsgs();
})();
