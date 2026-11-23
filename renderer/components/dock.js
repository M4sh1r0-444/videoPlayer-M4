/**
 * 统一停靠区（P3）：讲义 / AI / 笔记（占位）页签。
 *
 * - 宽度沿用 settings.panelWidths.ai（写到 CSS 变量，由断点 CSS 钳制）；
 * - 打开状态 / 当前页签由 ui.dockOpen / ui.dockTab 驱动；
 * - <1072px 时由容器查询切换为浮层，不参与 flex，不挤压播放器；
 * - 浮层模式点击背板或按 Esc 关闭，关闭后焦点回到打开前的元素。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { createDocsPanel } from './docs-panel.js';
import { createAiPanel } from './ai-panel.js';

const TABS = [
  { key: 'docs', label: '讲义', panel: 'dockPanelDocs', tabId: 'dockTabDocs' },
  { key: 'ai', label: 'AI', panel: 'dockPanelAi', tabId: 'dockTabAi' },
  { key: 'notes', label: '笔记', panel: 'dockPanelNotes', tabId: 'dockTabNotes', disabled: true },
];

export function createDock() {
  let root = null;
  let scrim = null;
  let main = null;
  let ctx = null;
  let docsPanel = null;
  let aiPanel = null;
  let tablist = null;
  let closeBtn = null;
  let panels = {};
  let buttons = {};
  let lastOpen = false;
  let lastTab = null;
  let lastWidth = null;
  let lastFocus = null;
  let destroyed = false;

  function tabOf(key) {
    return TABS.find((t) => t.key === key && !t.disabled) || TABS[0];
  }

  function focusPanel(tab) {
    if (tab === 'ai') aiPanel?.focusInput?.();
    else if (tab === 'docs') docsPanel?.focus?.();
  }

  function setTab(key, { focus = false } = {}) {
    if (!TABS.some((t) => t.key === key && !t.disabled)) return;
    if (ctx.store.get().ui.dockTab === key && ctx.store.get().ui.dockOpen) {
      if (focus) focusPanel(key);
      return;
    }
    ctx.store.dispatch('setDockTab', key);
    if (focus) focusPanel(key);
  }

  function close() {
    ctx.store.dispatch('setDockOpen', false);
  }

  function onTabClick(event) {
    const button = event.target instanceof Element ? event.target.closest('[data-dock-tab]') : null;
    if (!button || button.disabled) return;
    setTab(button.dataset.dockTab, { focus: false });
  }

  function enabledTabKeys() {
    return TABS.filter((t) => !t.disabled).map((t) => t.key);
  }

  function onTabKey(event) {
    const current = buttons[ctx.store.get().ui.dockTab];
    if (!current) return;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      event.preventDefault();
      const keys = enabledTabKeys();
      const index = keys.indexOf(current.dataset.dockTab);
      const delta = event.key === 'ArrowRight' ? 1 : -1;
      const next = keys[(index + delta + keys.length) % keys.length];
      setTab(next, { focus: true });
      buttons[next]?.focus();
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const keys = enabledTabKeys();
      const next = event.key === 'Home' ? keys[0] : keys[keys.length - 1];
      setTab(next, { focus: true });
      buttons[next]?.focus();
    }
  }

  function onDockKey(event) {
    if (event.key !== 'Escape') return;
    const active = document.activeElement;
    if (active && active.closest && active.closest('dialog[open]')) return;
    event.preventDefault();
    event.stopPropagation();
    close();
  }

  function onScrimClick() {
    close();
  }

  function render(state) {
    const open = !!state.ui.dockOpen;
    const tab = tabOf(state.ui.dockTab).key;
    root.classList.toggle('hidden', !open);
    main.dataset.dock = open ? 'open' : 'closed';
    main.dataset.dockTab = tab;

    for (const item of TABS) {
      const button = buttons[item.key];
      const panel = panels[item.key];
      if (button) {
        const selected = item.key === tab && !item.disabled;
        button.setAttribute('aria-selected', selected ? 'true' : 'false');
        button.tabIndex = selected ? 0 : -1;
        button.classList.toggle('on', selected);
      }
      if (panel) panel.classList.toggle('hidden', item.disabled || item.key !== tab);
    }

    docsPanel?.update(state);

    if (state.ui.panelWidths.ai !== lastWidth) {
      lastWidth = state.ui.panelWidths.ai;
      root.style.setProperty('--dock-pref', `${lastWidth}px`);
    }

    const tabChanged = open && lastOpen && lastTab && tab !== lastTab;
    // 焦点在页签按钮上（键盘左右切换）时保留；从顶栏/别处切换页签则把焦点带进面板。
    const onTabButton = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest('#dockTabs'));
    if (open && !lastOpen) {
      lastFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      // 等这次 click 冒泡到 document（输入框失焦策略）之后再交焦点
      requestAnimationFrame(() => {
        if (ctx.store.get().ui.dockOpen) focusPanel(ctx.store.get().ui.dockTab);
      });
    } else if (tabChanged && !onTabButton) {
      // 从顶栏按钮切换页签时把焦点带进面板；鼠标点页签本身则保留在 tab 上
      requestAnimationFrame(() => {
        if (ctx.store.get().ui.dockOpen) focusPanel(ctx.store.get().ui.dockTab);
      });
    } else if (!open && lastOpen) {
      const restore = lastFocus && document.contains(lastFocus) && !root.contains(lastFocus)
        ? lastFocus
        : document.getElementById(tab === 'ai' ? 'btnAI' : 'btnDocs');
      lastFocus = null;
      if (restore && typeof restore.focus === 'function') restore.focus();
    }
    lastOpen = open;
    lastTab = tab;
  }

  function mount(container, context) {
    ctx = context;
    main = container;
    main.dataset.dock = 'closed';
    docsPanel = createDocsPanel();
    aiPanel = createAiPanel();

    tablist = h('div', {
      id: 'dockTabs',
      class: 'dock-tabs',
      role: 'tablist',
      'aria-label': '停靠区页签',
    });
    for (const item of TABS) {
      const button = h('button', {
        id: item.tabId,
        class: 'dock-tab' + (item.disabled ? ' disabled' : ''),
        type: 'button',
        role: 'tab',
        'aria-selected': 'false',
        'aria-controls': item.panel,
        'data-dock-tab': item.key,
        tabindex: '-1',
        text: item.label,
        title: item.disabled ? '笔记功能将在 P4 实现' : (item.key === 'ai' ? 'AI 助手（Ctrl+I）' : '讲义 / 习题'),
      });
      if (item.disabled) {
        button.disabled = true;
        button.setAttribute('aria-disabled', 'true');
      }
      buttons[item.key] = button;
      tablist.append(button);
    }
    tablist.addEventListener('click', onTabClick);
    tablist.addEventListener('keydown', onTabKey);

    closeBtn = h('button', {
      id: 'dockClose',
      class: 'mini-btn dock-close',
      type: 'button',
      'aria-label': '关闭停靠区',
      title: '关闭（Esc）',
      onclick: close,
    }, [svgIcon('close', { size: 16 })]);

    const body = h('div', { class: 'dock-body' });
    for (const item of TABS) {
      const panel = h('div', {
        id: item.panel,
        class: 'dock-panel hidden',
        role: 'tabpanel',
        'aria-labelledby': item.tabId,
        tabindex: '0',
      });
      panels[item.key] = panel;
      body.append(panel);
    }

    root = h('aside', { id: 'dock', class: 'dock hidden', 'aria-label': '停靠区' }, [
      h('div', { class: 'dock-head' }, [tablist, closeBtn]),
      body,
    ]);
    scrim = h('div', { id: 'dockScrim', class: 'dock-scrim', 'aria-hidden': 'true' });
    scrim.addEventListener('click', onScrimClick);
    root.addEventListener('keydown', onDockKey);

    // 停靠区必须排在播放器之后，浮层时覆盖在内容上
    container.append(scrim, root);

    docsPanel.mount(panels.docs, context);
    aiPanel.mount(panels.ai, context);

    const notes = h('div', { class: 'dock-notes' }, [
      h('div', { class: 'dock-notes-title', text: '笔记' }),
      h('div', { class: 'dock-notes-body', text: '笔记功能将在 P4 实现；当前页签仅占位，不写入任何数据。' }),
    ]);
    panels.notes.append(notes);

    render(ctx.store.get());
    return { update: render, destroy, elements: { root, scrim } };
  }

  function destroy() {
    destroyed = true;
    tablist?.removeEventListener('click', onTabClick);
    tablist?.removeEventListener('keydown', onTabKey);
    root?.removeEventListener('keydown', onDockKey);
    scrim?.removeEventListener('click', onScrimClick);
    docsPanel?.destroy();
    aiPanel?.destroy();
    root?.remove();
    scrim?.remove();
    if (main) {
      delete main.dataset.dock;
      delete main.dataset.dockTab;
    }
    root = null;
    scrim = null;
    docsPanel = null;
    aiPanel = null;
    buttons = {};
    panels = {};
  }

  return { mount, destroy, update: render, get isOpen() { return lastOpen; }, get tab() { return lastTab; } };
}
