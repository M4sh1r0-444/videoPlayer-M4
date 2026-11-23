/**
 * AI 页签（P3）：从旧 ai.js 迁移到新路径。
 *
 * 与旧实现的差异（均为结构/状态归属调整，行为保持一致）：
 * - 不再依赖 state / video / esc / fmtTime / showToast / $ 六个隐式全局；
 * - 配置、消息、流式状态全部走 store.ai，通过 store.dispatch('ai*') 写入；
 * - 网络、截帧、历史仍走 data/api 封装的既有 26 个 IPC；
 * - 富文本仍走 marked → DOMPurify → KaTeX 管线（ui/rich-text.js）；
 * - 流式增量只更新当前气泡的 textContent，不重建消息列表。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { renderRich, applyRichStyles } from '../ui/rich-text.js';
import { fmtTime } from '../core/index.js';

function nowIso() {
  return new Date().toISOString();
}

function currentEpisode(state) {
  const course = state.library.course;
  const index = state.playback.index;
  return course && index >= 0 && course.episodes[index] ? { course, ep: course.episodes[index], index } : null;
}

function systemPrompt(ai, state, video) {
  const cfg = ai.config;
  let base = '你是一位耐心的学习辅导老师，擅长把复杂概念讲得清晰易懂。';
  const pair = currentEpisode(state);
  if (cfg.contextEnabled !== false && pair) {
    const pos = video && Number.isFinite(video.currentTime) ? fmtTime(video.currentTime) : '00:00';
    const dur = video && Number.isFinite(video.duration) ? fmtTime(video.duration) : '未知时长';
    const subject = state.library.subject ? state.library.subject.name : '';
    base += `用户正在学习《${pair.course.name}》（科目：${subject}），当前观看分集《${pair.ep.title}》（第 ${pair.index + 1} 集，播放位置 ${pos}/${dur}）。`;
  }
  base += '用中文简洁准确地回答，数学公式使用 LaTeX（行内 $...$，独立公式 $$...$$）。';
  if (cfg.systemPrompt) base += '\n' + cfg.systemPrompt;
  return base;
}

function apiMessages(ai, state, video) {
  const out = [{ role: 'system', content: systemPrompt(ai, state, video) }];
  for (const m of ai.messages.slice(-20)) {
    if (m.imgData) {
      const text = m.content === '（截图提问）'
        ? `请讲解画面中的内容（画面时间点 ${m.imgAt || ''}）`
        : `${m.content}（画面时间点 ${m.imgAt || ''}）`;
      out.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: m.imgData } },
          { type: 'text', text },
        ],
      });
    } else {
      out.push({ role: m.role, content: m.content });
    }
  }
  return out;
}

function messageNode(message, { streaming = false } = {}) {
  const isUser = message.role === 'user';
  const role = h('div', { class: 'ai-role', text: isUser ? '我' : 'AI' });
  const bubble = h('div', { class: 'ai-bubble' });
  if (message.imgAt) {
    bubble.append(h('div', { class: 'ai-imgtag' }, [
      svgIcon('camera', { size: 14 }),
      h('span', { text: `画面时间点 ${message.imgAt}` }),
    ]));
  }
  const content = h('div', { class: 'ai-content' });
  if (isUser) content.textContent = message.content;
  else if (streaming) {
    content.textContent = message.content;
    content.classList.add('ai-cursor');
  } else {
    content.innerHTML = renderRich(message.content);
    applyRichStyles(content);
  }
  bubble.append(content);
  const node = h('div', {
    class: 'ai-msg ' + (isUser ? 'user' : 'assistant'),
    dataset: { messageId: message.id || '' },
  }, [role, bubble]);
  return node;
}

function errorNode(message) {
  return h('div', { class: 'ai-msg assistant error', dataset: { transitory: 'error' } }, [
    h('div', { class: 'ai-role', text: '出错了' }),
    h('div', { class: 'ai-bubble' }, [h('div', { class: 'ai-content', text: message })]),
  ]);
}

export function createAiPanel() {
  let root = null;
  let ctx = null;
  let msgs = null;
  let input = null;
  let sendBtn = null;
  let shotBtn = null;
  let ctxChip = null;
  let ctxLabel = null;
  let shotBar = null;
  let shotImg = null;
  let shotText = null;
  let streamEl = null;
  let unsubStore = null;
  let unsubEvents = null;
  let lastMessages = null;
  let lastConfig = null;
  let lastStreamBuf = '';
  let lastError = null;
  let lastPending = null;
  let lastStreaming = false;
  let destroyed = false;
  let sendToken = 0;

  const ai = () => ctx.store.get().ai;

  function scrollBottom() {
    if (msgs) msgs.scrollTop = msgs.scrollHeight;
  }

  function welcomeNode() {
    const box = h('div', { class: 'ai-msg assistant' });
    const bubble = h('div', { class: 'ai-bubble ai-welcome' });
    bubble.append(
      h('div', { class: 'ai-welcome-brand' }, [
        svgIcon('sparkles', { size: 20 }),
        h('strong', { text: 'AI 学习助手' }),
      ]),
      h('p', { class: 'ai-welcome-text', text: '首次使用请先配置 AI 接口：设置 → AI 助手。' }),
      h('p', { class: 'ai-welcome-text', text: '支持 DeepSeek / Kimi / 智谱 GLM / OpenAI / Ollama 本地及各类中转站（OpenAI 兼容协议）。' }),
      h('p', { class: 'ai-welcome-text', text: '配置后即可流式问答（Markdown 与 LaTeX 公式渲染），播放中可点相机按钮截图提问。' }),
      h('button', {
        class: 'mini-btn',
        text: '去设置',
        onclick: () => ctx.store.dispatch('setModal', 'settings'),
      }),
    );
    box.append(bubble);
    return box;
  }

  function tipNode() {
    return h('div', {
      class: 'ai-welcome ai-welcome-tip',
    }, [
      svgIcon('sparkles', { size: 18 }),
      h('span', { text: '问点什么吧，例如：这一节的难点是什么？和上一节有什么联系？' }),
    ]);
  }

  function ensureStreamNode() {
    if (!streamEl) streamEl = messageNode({ id: 'stream', role: 'assistant', content: '' }, { streaming: true });
    return streamEl;
  }

  function renderMessages(state) {
    const { ai: aiState } = state;
    lastMessages = aiState.messages;
    lastError = aiState.error;
    const extra = [];
    if (!aiState.config.baseUrl) extra.push(welcomeNode());
    else if (!aiState.messages.length && !aiState.streaming) extra.push(tipNode());
    const messageNodes = aiState.messages.map((m) => messageNode(m));
    if (aiState.error) extra.push(errorNode(aiState.error));
    if (aiState.streaming) extra.push(ensureStreamNode());
    msgs.replaceChildren(...messageNodes, ...extra);
    if (aiState.streaming && streamEl) {
      const content = streamEl.querySelector('.ai-content');
      content.textContent = aiState.streamBuf;
      content.classList.add('ai-cursor');
    }
    lastStreamBuf = aiState.streamBuf;
    scrollBottom();
  }

  function updateStream(aiState) {
    if (!streamEl) {
      streamEl = ensureStreamNode();
      msgs.append(streamEl);
    }
    const content = streamEl.querySelector('.ai-content');
    if (content) {
      content.textContent = aiState.streamBuf;
      content.classList.add('ai-cursor');
    }
    // 流式结束由 renderMessages 负责移除（messages 引用变化会重建）
    lastStreamBuf = aiState.streamBuf;
    scrollBottom();
  }

  function renderShotBar(image) {
    if (!shotBar) return;
    if (!image) {
      shotBar.classList.add('hidden');
      if (shotImg) shotImg.removeAttribute('src');
      shotBtn?.classList.remove('pending');
      return;
    }
    if (shotImg) shotImg.src = image.dataUrl;
    if (shotText) shotText.textContent = `已截取 ${image.at} 的画面，将随下条提问发送`;
    shotBar.classList.remove('hidden');
    shotBtn?.classList.add('pending');
  }

  function setSendLabel(streaming) {
    if (!sendBtn) return;
    sendBtn.textContent = streaming ? '停止' : '发送';
    sendBtn.classList.toggle('streaming', streaming);
    sendBtn.setAttribute('aria-label', streaming ? '停止生成' : '发送消息');
  }

  function renderAll(state) {
    const aiState = state.ai;
    const configChanged = lastConfig !== aiState.config;
    const messagesChanged = lastMessages !== aiState.messages;
    const streamingChanged = lastStreaming !== aiState.streaming;
    lastConfig = aiState.config;

    if (configChanged || aiState.streaming !== lastStreaming) {
      renderMessages(state);
    } else if (messagesChanged && !aiState.streaming) {
      renderMessages(state);
    } else if (aiState.streaming) {
      if (!streamEl) renderMessages(state);
      else if (aiState.streamBuf !== lastStreamBuf) updateStream(aiState);
      if (aiState.error && lastError !== aiState.error) renderMessages(state);
    } else if (messagesChanged || aiState.error !== lastError) {
      renderMessages(state);
    } else if (!msgs.childElementCount && !aiState.messages.length) {
      renderMessages(state);
    }

    if (streamingChanged) {
      setSendLabel(aiState.streaming);
      if (!aiState.streaming) {
        streamEl = null;
        // 完成/失败后 messages / error 已变化，重建一次拿到最终结果
        if (lastMessages !== aiState.messages || lastError !== aiState.error) renderMessages(state);
      }
    }
    lastStreaming = aiState.streaming;

    if (aiState.pendingImage !== lastPending) {
      lastPending = aiState.pendingImage;
      renderShotBar(aiState.pendingImage);
    }

    if (ctxChip) {
      const current = aiState.config.contextEnabled !== false;
      const label = '上下文：' + (current ? '开' : '关');
      if (ctxLabel && ctxLabel.textContent !== label) ctxLabel.textContent = label;
      ctxChip.classList.toggle('is-on', current);
      ctxChip.setAttribute('aria-pressed', current ? 'true' : 'false');
    }
  }

  async function doSend() {
    const state = ctx.store.get();
    const aiState = state.ai;
    if (aiState.streaming) {
      ctx.api.aiAbort();
      return;
    }
    const text = input.value.trim();
    const image = aiState.pendingImage;
    if (!text && !image) return;
    if (!aiState.config.baseUrl) {
      ctx.toast.show('请先在「设置 → AI 助手」配置接口');
      ctx.store.dispatch('setModal', 'settings');
      return;
    }

    const userMessage = {
      role: 'user',
      content: text || '（截图提问）',
      ts: nowIso(),
      imgAt: image ? image.at : null,
      imgData: image ? image.dataUrl : null,
    };
    ctx.store.dispatch('appendAiMessage', userMessage);
    input.value = '';
    ctx.store.dispatch('clearAiPendingImage');
    ctx.store.dispatch('startAiStream', null);
    setSendLabel(true);
    const token = ++sendToken;

    try {
      const payload = apiMessages(ai(), ctx.store.get(), ctx.getVideo?.());
      const result = await ctx.api.aiSend(payload);
      ctx.store.dispatch('clearAiImageData');
      if (token !== sendToken) return;
      if (!result.ok) {
        ctx.store.dispatch('failAiStream', {
          message: (result.error && result.error.message) || '发送失败',
          partial: ctx.store.get().ai.streamBuf,
        });
        return;
      }
      const data = result.data || {};
      if (!data.ok) {
        ctx.store.dispatch('failAiStream', { message: data.error || '发送失败', partial: ctx.store.get().ai.streamBuf });
        return;
      }
      // 响应可能在 IPC 返回前就完成/中断，避免把已结束的请求重新标成流式中
      if (!ctx.store.get().ai.streaming) return;
      ctx.store.dispatch('startAiStream', data.requestId);
    } catch (err) {
      ctx.store.dispatch('clearAiImageData');
      ctx.store.dispatch('failAiStream', {
        message: '发送失败：' + (err && err.message ? err.message : err),
        partial: ctx.store.get().ai.streamBuf,
      });
    }
  }

  function onAiEvent(arg) {
    if (!arg || destroyed) return;
    const aiState = ctx.store.get().ai;
    if (!aiState.streaming) return;
    if (aiState.requestId != null && arg.requestId !== aiState.requestId) return;
    if (arg.delta != null) {
      ctx.store.dispatch('appendAiDelta', arg.delta);
    } else if (arg.content != null) {
      ctx.store.dispatch('finishAiStream', arg.content);
    } else if (arg.message) {
      ctx.store.dispatch('failAiStream', { message: arg.message, partial: aiState.streamBuf });
    }
  }

  async function captureShot() {
    const state = ctx.store.get();
    const pair = currentEpisode(state);
    const video = ctx.getVideo?.();
    if (!pair || !video) {
      ctx.toast.show('先播放一个视频，再截图提问');
      return;
    }
    ctx.toast.show('正在截取画面…');
    const at = Number.isFinite(video.currentTime) ? fmtTime(video.currentTime) : '00:00';
    const result = await ctx.api.aiCaptureFrame(pair.ep.path, video.currentTime);
    const data = result.ok ? result.data : null;
    if (data && data.dataUrl) {
      ctx.store.dispatch('setAiPendingImage', { dataUrl: data.dataUrl, at });
      input.focus();
    } else {
      ctx.toast.show((data && data.error) || (result.error && result.error.message) || '截图失败');
    }
  }

  async function clearHistory() {
    if (!ai().messages.length) return;
    if (!window.confirm('确定清空全部对话记录？此操作不可恢复。')) return;
    await ctx.store.dispatch('clearAiHistory');
    ctx.toast.show('对话已清空');
  }

  function onChipClick(event) {
    const button = event.target instanceof Element ? event.target.closest('.ai-chip') : null;
    if (!button) return;
    input.value = button.textContent;
    input.focus();
  }

  function onInputKey(event) {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      doSend();
    }
  }

  function mount(container, context) {
    ctx = context;
    root = h('div', { id: 'aiPanel', class: 'ai-panel' });
    msgs = h('div', {
      id: 'aiMsgs',
      class: 'ai-msgs',
      role: 'log',
      'aria-live': 'polite',
      'aria-relevant': 'additions text',
      'aria-label': 'AI 对话记录',
    });
    ctxLabel = h('span', { class: 'ai-ctx-label', text: '上下文：开' });
    ctxChip = h('button', {
      id: 'aiCtxChip',
      class: 'mini-btn ai-ctx-btn is-on',
      type: 'button',
      'aria-pressed': 'true',
      'aria-label': '切换上下文注入',
      title: '自动把当前课程/分集/播放位置告诉 AI',
      onclick: () => ctx.store.dispatch('setAiContext', ai().config.contextEnabled === false),
    }, [svgIcon('link', { size: 14 }), ctxLabel]);
    const clearBtn = h('button', {
      id: 'aiClear',
      class: 'mini-btn ai-clear-btn',
      type: 'button',
      'aria-label': '清空对话历史',
      title: '清空对话历史（不可恢复）',
      onclick: clearHistory,
    }, [svgIcon('trash', { size: 14 }), h('span', { text: '清空' })]);
    const tools = h('div', { class: 'ai-composer-tools' }, [
      ctxChip,
      clearBtn,
    ]);

    const chips = h('div', { id: 'aiChips', class: 'ai-chips', role: 'group', 'aria-label': '快捷提问' });
    for (const text of ['解释这一节', '举个例子', '总结要点']) {
      chips.append(h('button', { class: 'ai-chip', type: 'button', text }));
    }

    shotBtn = h('button', {
      id: 'aiShot',
      class: 'ctl icon',
      type: 'button',
      'aria-label': '截图提问',
      title: '截取当前视频画面，随下条提问发送',
      onclick: captureShot,
    }, [svgIcon('camera', { size: 18 })]);
    input = h('textarea', {
      id: 'aiInput',
      rows: 1,
      placeholder: '问点什么…',
      'aria-label': '向 AI 提问',
    });
    sendBtn = h('button', {
      id: 'aiSend',
      class: 'btn primary',
      type: 'button',
      text: '发送',
      'aria-label': '发送消息',
      onclick: doSend,
    });

    shotImg = h('img', { alt: '截图预览', class: 'ai-shot-img' });
    shotText = h('span', { class: 'ai-shot-text' });
    shotBar = h('div', { id: 'aiShotBar', class: 'ai-shot-bar hidden' }, [
      shotImg,
      shotText,
      h('button', {
        type: 'button',
        class: 'mini-btn ai-shot-cancel',
        'aria-label': '取消截图',
        title: '取消截图',
        onclick: () => ctx.store.dispatch('clearAiPendingImage'),
      }, [svgIcon('close', { size: 14 })]),
    ]);
    const inputBar = h('div', { id: 'aiInputBar', class: 'ai-input-bar' }, [shotBtn, input, sendBtn]);
    const composerHint = h('div', { class: 'ai-composer-hint' }, [
      h('span', { text: 'Enter 发送' }),
      h('span', { class: 'ai-hint-dot', 'aria-hidden': 'true', text: '·' }),
      h('span', { text: 'Shift+Enter 换行' }),
    ]);
    const composer = h('div', { id: 'aiComposer', class: 'ai-composer' }, [
      tools,
      shotBar,
      inputBar,
      composerHint,
    ]);

    root.append(msgs, chips, composer);
    container.append(root);

    input.addEventListener('keydown', onInputKey);
    chips.addEventListener('click', onChipClick);

    unsubStore = ctx.store.subscribe((state) => state.ai, (aiState) => {
      if (!destroyed) renderAll({ ...ctx.store.get(), ai: aiState });
    });
    const sub = ctx.api.onAiEvent(onAiEvent);
    unsubEvents = sub.ok ? sub.data : null;

    renderAll(ctx.store.get());
    if (!ctx.store.get().ai.historyLoaded) ctx.store.dispatch('loadAiHistory');
    return { update: () => renderAll(ctx.store.get()), destroy, focusInput: () => input.focus(), root };
  }

  function destroy() {
    destroyed = true;
    try {
      if (typeof unsubEvents === 'function') unsubEvents();
    } catch {
      /* 已解绑 */
    }
    unsubEvents = null;
    unsubStore?.();
    unsubStore = null;
    input?.removeEventListener('keydown', onInputKey);
    root?.remove();
    root = null;
    msgs = null;
    streamEl = null;
  }

  return { mount, destroy, focusInput: () => input?.focus() };
}
