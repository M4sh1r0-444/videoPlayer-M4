/**
 * P3 AI 状态机单测：配置、消息、流式、中断、历史形状（不依赖 DOM / Electron）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { createStore, hydrateState } from '../renderer/data/store.js';
import { createAiActions, historyPayload, hydrateMessage } from '../renderer/data/ai-actions.js';

function makeHarness() {
  const store = createStore(hydrateState({
    ai: { baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', contextEnabled: true, systemPrompt: 's' },
  }));
  const calls = { save: [], config: [], clear: 0, test: 0 };
  const api = {
    aiHistoryLoad: async () => ({ ok: true, data: { messages: [{ role: 'user', content: '旧消息', ts: '2026-01-01T00:00:00.000Z' }] } }),
    aiHistorySave: async (data) => { calls.save.push(data); return { ok: true, data: true }; },
    aiHistoryClear: async () => { calls.clear++; return { ok: true, data: true }; },
    aiSaveConfig: async (cfg) => { calls.config.push(cfg); return { ok: true, data: true }; },
    aiTest: async () => { calls.test++; return { ok: true, data: { ok: true, message: '连接成功' } }; },
  };
  const toast = { show() {} };
  const actions = createAiActions({ store, api, toast });
  return { store, api, calls, actions };
}

test('hydrateState：ai 切片默认值与 learn.json 形状不变', () => {
  const state = hydrateState({ ai: { baseUrl: 'u', apiKey: 'k', model: 'm', contextEnabled: false, systemPrompt: 'p' } });
  assert.deepEqual(state.ai.config, { baseUrl: 'u', apiKey: 'k', model: 'm', contextEnabled: false, systemPrompt: 'p' });
  assert.deepEqual(state.ai.messages, []);
  assert.equal(state.ai.streaming, false);
  assert.equal(state.ui.dockOpen, false);
  assert.equal(state.ui.dockTab, 'ai');
  assert.equal(state.ui.navCollapsed, false);
});

test('hydrateMessage / historyPayload：id/imgData 不落盘', () => {
  const m = hydrateMessage({ role: 'user', content: 'q', ts: 't', imgAt: '00:01', imgData: 'data:image/jpeg;base64,xx' });
  assert.ok(m.id);
  assert.equal(m.imgAt, '00:01');
  assert.equal(m.imgData.startsWith('data:'), true);
  const payload = historyPayload([m, { role: 'assistant', content: 'a', ts: 't2' }]);
  assert.deepEqual(payload, [
    { role: 'user', content: 'q', ts: 't', imgAt: '00:01' },
    { role: 'assistant', content: 'a', ts: 't2' },
  ]);
});

test('loadAiHistory：补 id 且只加载一次', async () => {
  const { store, actions } = makeHarness();
  const messages = await actions.loadAiHistory();
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, '旧消息');
  assert.ok(messages[0].id);
  assert.equal(store.get().ai.historyLoaded, true);
  await actions.loadAiHistory();
  assert.equal(store.get().ai.messages.length, 1);
});

test('setAiConfig：合并配置、调用 ai-save-config、保留 contextEnabled', async () => {
  const { store, actions, calls } = makeHarness();
  await actions.setAiConfig({ baseUrl: 'http://new/v1', model: 'm2' });
  assert.equal(store.get().ai.config.baseUrl, 'http://new/v1');
  assert.equal(store.get().ai.config.model, 'm2');
  assert.equal(store.get().ai.config.contextEnabled, true);
  assert.equal(calls.config.length, 1);
  assert.equal(calls.config[0].apiKey, 'k');
});

test('消息追加 + 流式状态机 + 历史保存', () => {
  const { store, actions, calls } = makeHarness();
  const user = actions.appendAiMessage({ role: 'user', content: '问', ts: 't1', imgAt: '00:02', imgData: 'data:img' });
  assert.equal(store.get().ai.messages.length, 1);
  assert.equal(store.get().ai.messages[0].id, user.id);
  assert.equal(calls.save.length, 1);
  assert.equal(calls.save[0].messages[0].imgData, undefined);

  actions.startAiStream(null);
  assert.equal(store.get().ai.streaming, true);
  actions.startAiStream(42);
  assert.equal(store.get().ai.requestId, 42);
  actions.appendAiDelta('你');
  actions.appendAiDelta('好');
  assert.equal(store.get().ai.streamBuf, '你好');
  actions.finishAiStream('你好');
  assert.equal(store.get().ai.streaming, false);
  assert.equal(store.get().ai.requestId, null);
  assert.equal(store.get().ai.messages.length, 2);
  assert.equal(store.get().ai.messages[1].content, '你好');
  assert.equal(calls.save.at(-1).messages.length, 2);
});

test('中断：保留部分内容并记录错误，不丢用户问题', () => {
  const { store, actions, calls } = makeHarness();
  actions.appendAiMessage({ role: 'user', content: '问题', ts: 't' });
  actions.startAiStream(7);
  actions.appendAiDelta('部分');
  actions.failAiStream({ message: '已停止', partial: '部分' });
  const ai = store.get().ai;
  assert.equal(ai.streaming, false);
  assert.equal(ai.error, '已停止');
  assert.equal(ai.messages.length, 2);
  assert.equal(ai.messages[1].content, '部分\n\n（回答被中断）');
  assert.equal(calls.save.at(-1).messages.length, 2);
});

test('清空历史：消息与 pendingImage 清空 + ai-history-clear', async () => {
  const { store, actions, calls } = makeHarness();
  actions.appendAiMessage({ role: 'user', content: '问', ts: 't' });
  actions.setAiPendingImage({ dataUrl: 'data:x', at: '00:01' });
  assert.equal(store.get().ai.pendingImage.at, '00:01');
  await actions.clearAiHistory();
  assert.equal(store.get().ai.messages.length, 0);
  assert.equal(store.get().ai.pendingImage, null);
  assert.equal(calls.clear, 1);
});

test('testAiConnection：结果写入 ai.testing / testMessage', async () => {
  const { store, actions, calls } = makeHarness();
  const result = await actions.testAiConnection();
  assert.equal(result.ok, true);
  assert.equal(calls.test, 1);
  assert.equal(store.get().ai.testing, false);
  assert.equal(store.get().ai.testMessage, '连接成功');
  assert.equal(store.get().ai.testOk, true);
});
