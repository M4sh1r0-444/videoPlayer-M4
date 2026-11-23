/**
 * AI 域 actions（P3）：AI 配置、会话消息、流式状态与历史的唯一写入口。
 *
 * 边界：
 * - 只改 store.ai，不直接碰 DOM；组件通过 store.dispatch 调用这里。
 * - 配置与历史继续走既有 IPC（ai-save-config / ai-history-*），不改通道。
 * - ai-history.json 的消息形状与 v0.4.4 一致：{ role, content, ts, imgAt? }；
 *   内存里的 id / imgData 不落盘，learn.json 的 ai 字段形状也不变。
 */

let seq = 0;
function messageId() {
  seq += 1;
  return 'm' + Date.now().toString(36) + seq.toString(36);
}

/** 历史 / 外部消息 → 内存消息（补 id，保留 imgAt） */
export function hydrateMessage(raw) {
  const role = raw && raw.role === 'user' ? 'user' : 'assistant';
  const message = {
    id: raw && raw.id ? String(raw.id) : messageId(),
    role,
    content: String((raw && raw.content) ?? ''),
    ts: raw && raw.ts ? String(raw.ts) : new Date().toISOString(),
  };
  if (raw && raw.imgAt) message.imgAt = String(raw.imgAt);
  if (raw && raw.imgData) message.imgData = String(raw.imgData);
  return message;
}

/** 只保留 v0.4.4 的历史字段（id / imgData 不入 ai-history.json） */
export function historyPayload(messages) {
  return (messages || []).map((m) => {
    const item = { role: m.role, content: m.content, ts: m.ts };
    if (m.imgAt) item.imgAt = m.imgAt;
    return item;
  });
}

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   api: ReturnType<import('./api.js').createApi>,
 *   toast?: { show: Function },
 *   openSettings?: () => void,
 * }} deps
 */
export function createAiActions({ store, api, toast, openSettings }) {
  const say = (message) => {
    try {
      toast?.show?.(message);
    } catch {
      /* toast 不是业务状态 */
    }
  };

  function patchAi(updater) {
    store.set((s) => ({ ...s, ai: updater(s.ai) }));
  }

  function getAi() {
    return store.get().ai;
  }

  function saveHistory(messages = getAi().messages) {
    // IPC 自身 300ms 防抖；失败不阻塞对话（下次消息再写）。
    api.aiHistorySave({ messages: historyPayload(messages) });
  }

  async function loadAiHistory() {
    if (getAi().historyLoaded) return getAi().messages;
    const result = await api.aiHistoryLoad();
    const raw = result.ok && result.data && Array.isArray(result.data.messages) ? result.data.messages : [];
    const messages = raw.map(hydrateMessage);
    patchAi((ai) => ({ ...ai, messages, historyLoaded: true }));
    return messages;
  }

  async function setAiConfig(patch) {
    const current = getAi().config;
    const next = { ...current, ...patch };
    patchAi((ai) => ({ ...ai, config: next }));
    const result = await api.aiSaveConfig(next);
    if (!result.ok) say('AI 配置保存失败，请稍后重试');
    return result.ok;
  }

  async function setAiContext(enabled) {
    return setAiConfig({ contextEnabled: !!enabled });
  }

  async function setAiTestResult({ testing, message, ok }) {
    patchAi((ai) => ({
      ...ai,
      testing: !!testing,
      testMessage: message == null ? ai.testMessage : String(message),
      testOk: ok == null ? ai.testOk : !!ok,
    }));
  }

  async function testAiConnection() {
    await setAiTestResult({ testing: true, message: '正在连接…', ok: null });
    const result = await api.aiTest();
    const data = result.ok ? result.data : null;
    const ok = !!(data && data.ok);
    const message = (data && data.message) || (result.ok ? '调用失败' : (result.error && result.error.message) || '调用失败');
    await setAiTestResult({ testing: false, message, ok });
    return { ok, message };
  }

  function appendAiMessage(raw) {
    const message = hydrateMessage(raw);
    patchAi((ai) => ({ ...ai, messages: [...ai.messages, message], error: null }));
    saveHistory();
    return message;
  }

  function clearAiError() {
    if (getAi().error == null) return;
    patchAi((ai) => ({ ...ai, error: null }));
  }

  function startAiStream(requestId) {
    patchAi((ai) => ({
      ...ai,
      streaming: true,
      // 第二次调用用于补上 requestId：保留已经到达的增量，避免竞态丢字
      requestId: requestId == null ? (ai.streaming ? ai.requestId : null) : requestId,
      streamBuf: ai.streaming ? ai.streamBuf : '',
      error: null,
    }));
  }

  function appendAiDelta(delta) {
    if (delta == null) return;
    patchAi((ai) => (ai.streaming ? { ...ai, streamBuf: ai.streamBuf + String(delta) } : ai));
  }

  function finishAiStream(content) {
    const text = String(content ?? getAi().streamBuf);
    const message = hydrateMessage({ role: 'assistant', content: text });
    patchAi((ai) => ({
      ...ai,
      messages: [...ai.messages, message],
      streaming: false,
      requestId: null,
      streamBuf: '',
      error: null,
    }));
    saveHistory();
    return message;
  }

  /**
   * 出错 / 中断：已收到的部分内容保留为回答（与旧 ai.js 一致）。
   * @param {{message?: string, partial?: string}} [info]
   */
  function failAiStream({ message = '发送失败', partial = '' } = {}) {
    const partialText = String(partial || '');
    let messages = getAi().messages;
    if (partialText.trim()) {
      messages = [...messages, hydrateMessage({ role: 'assistant', content: partialText + '\n\n（回答被中断）' })];
    }
    patchAi((ai) => ({
      ...ai,
      messages,
      streaming: false,
      requestId: null,
      streamBuf: '',
      error: String(message || '发送失败'),
    }));
    if (partialText.trim()) saveHistory(messages);
  }

  function setAiPendingImage(image) {
    patchAi((ai) => ({
      ...ai,
      pendingImage: image
        ? { dataUrl: String(image.dataUrl || ''), at: String(image.at || '') }
        : null,
    }));
  }

  function clearAiPendingImage() {
    if (!getAi().pendingImage) return;
    patchAi((ai) => ({ ...ai, pendingImage: null }));
  }

  /** 截图只随本条消息发送一次：请求发出后立即从内存消息里剔除 base64 */
  function clearAiImageData() {
    const messages = getAi().messages.map((m) => {
      if (!m.imgData) return m;
      const { imgData, ...rest } = m;
      return rest;
    });
    patchAi((ai) => ({ ...ai, messages }));
  }

  async function clearAiHistory() {
    patchAi((ai) => ({
      ...ai,
      messages: [],
      streaming: false,
      requestId: null,
      streamBuf: '',
      error: null,
      pendingImage: null,
    }));
    // 与旧 ai.js 一致：ai-history-clear 直接删除文件；下次有新消息再写
    await api.aiHistoryClear();
  }

  function openSettings() {
    if (typeof openSettings === 'function') openSettings();
    else store.dispatch('setModal', 'settings');
  }

  return {
    loadAiHistory,
    saveAiHistory: () => saveHistory(),
    setAiConfig,
    setAiContext,
    setAiTestResult,
    testAiConnection,
    appendAiMessage,
    clearAiError,
    startAiStream,
    appendAiDelta,
    finishAiStream,
    failAiStream,
    setAiPendingImage,
    clearAiPendingImage,
    clearAiImageData,
    clearAiHistory,
    openSettings,
  };
}
