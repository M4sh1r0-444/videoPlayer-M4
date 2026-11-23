/**
 * 设置弹窗（P3）：目录管理 / 缓存清理 / 自动连播 / AI 配置。
 *
 * 宿主换成原生 <dialog>（由 ui/dialog 接管 Esc、焦点陷阱、焦点归还、背板关闭）；
 * 静态骨架仍复用 v0.4.4 的 .modal-card，避免重复维护表单。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { fmtBytes } from '../core/index.js';

const AI_PRESETS = {
  deepseek: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  kimi: { baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  zhipu: { baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  openai: { baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  ollama: { baseUrl: 'http://127.0.0.1:11434/v1', model: 'qwen2.5:7b' },
};

export function createSettingsDialog() {
  let dialogEl = null;
  let dialog = null;
  let rootList = null;
  let cacheList = null;
  let autoNext = null;
  let aiPreset = null;
  let aiBaseUrl = null;
  let aiApiKey = null;
  let aiModel = null;
  let aiSysPrompt = null;
  let aiTestBtn = null;
  let aiTestMsg = null;
  let titleEl = null;
  let ctx = null;
  let isOpen = false;
  let lastRoots = null;
  let lastAutoNext = null;
  let lastAiConfig = null;
  let lastTestMessage = null;
  let lastTestOk = null;
  let lastTesting = null;

  function $id(id) {
    return dialogEl ? dialogEl.querySelector(`#${id}`) : document.getElementById(id);
  }

  function renderRoots(state) {
    rootList.replaceChildren();
    if (!state.library.roots.length) {
      rootList.append(h('div', { class: 'hint-row', text: '尚未添加学习目录' }));
      return;
    }
    for (const root of state.library.roots) {
      rootList.append(h('div', { class: 'root-item' }, [
        h('span', { class: 'rp', text: root, title: root }),
        h('button', {
          type: 'button',
          title: '移除',
          dataset: { root },
          'aria-label': `移除学习目录 ${root}`,
        }, [svgIcon('close', { size: 14 })]),
      ]));
    }
  }

  async function renderCacheRows() {
    const result = await ctx.api.cacheStats();
    if (!isOpen || ctx.store.get().ui.modal !== 'settings') return;
    cacheList.replaceChildren();
    if (!result.ok) return;
    const stats = result.data || {};
    const rows = [
      { key: 'thumbnails', label: '缩略图缓存', st: stats.thumbnails || { files: 0, bytes: 0 } },
      { key: 'remux', label: '转封装缓存', st: stats.remux || { files: 0, bytes: 0 } },
    ];
    for (const row of rows) {
      cacheList.append(h('div', { class: 'root-item' }, [
        h('span', { class: 'rp', text: `${row.label}：${row.st.files} 个文件 · ${fmtBytes(row.st.bytes)}` }),
        h('button', {
          type: 'button',
          text: '清理',
          title: '一键清理',
          dataset: { cache: row.key },
          'aria-label': `清理${row.label}`,
        }),
      ]));
    }
  }

  function renderAiForm(config) {
    if (!aiBaseUrl) return;
    aiPreset.value = '';
    aiBaseUrl.value = config.baseUrl || '';
    aiApiKey.value = config.apiKey || '';
    aiModel.value = config.model || '';
    aiSysPrompt.value = config.systemPrompt || '';
  }

  function renderTestState(state) {
    if (!aiTestMsg) return;
    if (state.ai.testing) {
      aiTestMsg.textContent = '正在连接…';
      aiTestMsg.className = 'ai-test-msg';
    } else if (state.ai.testMessage) {
      aiTestMsg.textContent = state.ai.testMessage;
      aiTestMsg.className = 'ai-test-msg ' + (state.ai.testOk ? 'ok' : 'bad');
    } else {
      aiTestMsg.textContent = '';
      aiTestMsg.className = 'ai-test-msg';
    }
    if (aiTestBtn) aiTestBtn.disabled = !!state.ai.testing;
  }

  function saveAiForm() {
    const config = ctx.store.get().ai.config;
    ctx.store.dispatch('setAiConfig', {
      baseUrl: aiBaseUrl.value.trim(),
      apiKey: aiApiKey.value.trim(),
      model: aiModel.value.trim(),
      systemPrompt: aiSysPrompt.value,
      contextEnabled: config.contextEnabled !== false,
    });
  }

  async function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('#setClose')) {
      ctx.store.dispatch('setModal', null);
      return;
    }
    if (target.closest('#openDataDir')) {
      event.preventDefault();
      ctx.api.openUserData();
      return;
    }
    if (target.closest('#aiTestBtn')) {
      saveAiForm();
      await ctx.store.dispatch('testAiConnection');
      return;
    }
    const removeBtn = target.closest('button[data-root]');
    if (removeBtn) {
      await ctx.store.dispatch('removeRoot', removeBtn.dataset.root);
      return;
    }
    const cacheBtn = target.closest('button[data-cache]');
    if (cacheBtn) {
      const label = cacheBtn.dataset.cache === 'remux' ? '转封装缓存' : '缩略图缓存';
      await ctx.api.cacheClear(cacheBtn.dataset.cache);
      ctx.toast.show(`已清理${label}`);
      renderCacheRows();
    }
  }

  function onChange(event) {
    const target = event.target;
    if (target === autoNext) {
      ctx.store.dispatch('setAutoNext', autoNext.checked);
      return;
    }
    if (target === aiPreset) {
      const preset = AI_PRESETS[aiPreset.value];
      if (!preset) return;
      aiBaseUrl.value = preset.baseUrl;
      aiModel.value = preset.model;
      saveAiForm();
      return;
    }
    if (target === aiBaseUrl || target === aiApiKey || target === aiModel || target === aiSysPrompt) {
      saveAiForm();
    }
  }

  function adopt(container) {
    const legacy = container;
    const card = legacy.querySelector('.modal-card');
    titleEl = card ? card.querySelector('.modal-title') : null;
    if (titleEl) titleEl.id = 'settingsTitle';
    dialogEl = h('dialog', {
      id: 'settingsModal',
      class: 'modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'settingsTitle',
    });
    if (card) dialogEl.append(card);
    legacy.replaceWith(dialogEl);
    dialogEl.classList.remove('hidden');
    dialog = ctx.ui.createDialog(dialogEl, {
      closeOnBackdrop: true,
      initialFocus: '#setAutoNext',
      returnFocus: '#btnSettings',
      onClose: () => {
        if (ctx.store.get().ui.modal === 'settings') ctx.store.dispatch('setModal', null);
      },
    });
  }

  function mount(container, context) {
    ctx = context;
    adopt(container);
    rootList = $id('rootList');
    cacheList = $id('cacheList');
    autoNext = $id('setAutoNext');
    aiPreset = $id('aiPreset');
    aiBaseUrl = $id('aiBaseUrl');
    aiApiKey = $id('aiApiKey');
    aiModel = $id('aiModel');
    aiSysPrompt = $id('aiSysPrompt');
    aiTestBtn = $id('aiTestBtn');
    aiTestMsg = $id('aiTestMsg');
    for (const el of [autoNext, aiPreset, aiBaseUrl, aiApiKey, aiModel, aiSysPrompt, aiTestBtn]) {
      if (el) el.addEventListener('change', onChange);
    }
    dialogEl.addEventListener('click', onClick);
    return { update, destroy };
  }

  function update(state) {
    const open = state.ui.modal === 'settings';
    if (open) {
      if (!isOpen) {
        isOpen = true;
        renderRoots(state);
        autoNext.checked = !!state.ui.autoNext;
        renderAiForm(state.ai.config);
        lastAiConfig = state.ai.config;
        lastRoots = state.library.roots;
        lastAutoNext = state.ui.autoNext;
        renderTestState(state);
        lastTestMessage = state.ai.testMessage;
        lastTestOk = state.ai.testOk;
        lastTesting = state.ai.testing;
        dialog.show();
        renderCacheRows();
      } else {
        if (state.library.roots !== lastRoots) {
          renderRoots(state);
          lastRoots = state.library.roots;
        }
        if (state.ui.autoNext !== lastAutoNext) {
          autoNext.checked = !!state.ui.autoNext;
          lastAutoNext = state.ui.autoNext;
        }
        // 只监听 AI 配置 / 测试状态的引用变化，避免覆盖用户正在输入的表单
        if (state.ai.config !== lastAiConfig) {
          lastAiConfig = state.ai.config;
          if (document.activeElement === aiBaseUrl || document.activeElement === aiApiKey
            || document.activeElement === aiModel || document.activeElement === aiSysPrompt) {
            // 用户正在输入：不回写表单，保存后 store 值与输入一致
          } else {
            renderAiForm(state.ai.config);
          }
        }
      }
      if (state.ai.testMessage !== lastTestMessage || state.ai.testOk !== lastTestOk || state.ai.testing !== lastTesting) {
        lastTestMessage = state.ai.testMessage;
        lastTestOk = state.ai.testOk;
        lastTesting = state.ai.testing;
        renderTestState(state);
      }
      isOpen = true;
    } else {
      if (isOpen) dialog?.close();
      isOpen = false;
    }
  }

  function destroy() {
    for (const el of [autoNext, aiPreset, aiBaseUrl, aiApiKey, aiModel, aiSysPrompt, aiTestBtn]) {
      el?.removeEventListener('change', onChange);
    }
    dialogEl?.removeEventListener('click', onClick);
    dialog = null;
    dialogEl?.remove();
    dialogEl = null;
  }

  return { mount, update, destroy };
}
