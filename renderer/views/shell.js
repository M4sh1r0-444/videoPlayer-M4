/**
 * 组合根（P3）：装配 store / api / persist / actions、布局状态与全部组件。
 *
 * 只做 wiring，不承载业务规则；所有状态变更经 store.dispatch。
 * P4 起 core / ui 由构建产物静态打进同一个 bundle，不再等待 window.LibsReady；
 * ?legacy=1 的旧界面才通过 lib-boot.js 拿到 window.Core / window.UI。
 * 新路径不提供 ai.js 的六个兼容全局：需要读取状态时使用显式测试钩子
 * `window.__VDS_STORE / __VDS_ACTIONS / __VDS`。
 */

import * as core from '../core/index.js';
import * as ui from '../ui/index.js';
import { createApi } from '../data/api.js';
import { createStore, hydrateState } from '../data/store.js';
import { createPersist } from '../data/persist.js';
import { createActions, readUiPrefs } from '../data/actions.js';
import { createTopbar } from '../components/topbar.js';
import { createSettingsDialog } from '../components/settings-dialog.js';
import { createImportDialog } from '../components/import-dialog.js';
import { createDock } from '../components/dock.js';
import { createHelpDialog } from '../components/help-dialog.js';
import { createLibraryView } from './library-view.js';
import { createDashboardView } from './dashboard-view.js';
import { h } from '../ui/dom.js';

const NARROW_MAX = 1279;

/** 新壳不再需要旧浮层/分隔条；?legacy=1 不会执行到这里 */
function removeLegacyChrome() {
  for (const id of ['docsMenu', 'aiPanel', 'aiSplit', 'sbSplit', 'epSplit']) {
    document.getElementById(id)?.remove();
  }
  // 悬停预览改为相对分集栏定位（CSP 下只用 CSS，不写内联样式）
  const preview = document.getElementById('hoverPreview');
  const panel = document.getElementById('episodePanel');
  if (preview && panel && preview.parentElement !== panel) panel.append(preview);
}

function installNavScrim(main, store) {
  const sidebar = document.getElementById('sidebar');
  const scrim = h('div', { id: 'navScrim', class: 'nav-scrim', 'aria-hidden': 'true' });
  if (sidebar && sidebar.nextSibling) main.insertBefore(scrim, sidebar.nextSibling);
  else main.append(scrim);
  scrim.addEventListener('click', () => store.dispatch('setNavDrawerOpen', false));
  return scrim;
}

export async function startApp() {
  const toast = ui.createToast(document.getElementById('toast'));
  const api = createApi();
  const loaded = await api.getStore();
  const initial = hydrateState(loaded.ok ? loaded.data : {});
  const prefs = readUiPrefs();
  initial.ui.dockTab = prefs.dockTab;
  initial.ui.navCollapsed = prefs.navCollapsed;

  const store = createStore(initial);
  const persist = createPersist({
    api,
    onError: () => toast.show('保存失败，将在下次操作时重试'),
  });

  let libraryView = null;
  const actions = createActions({
    store,
    api,
    persist,
    toast,
    beforeChange: () => libraryView?.player?.flushProgress?.(),
  });
  const ctx = { store, api, ui, toast };
  ctx.isNarrow = () => window.innerWidth <= NARROW_MAX;

  const main = document.getElementById('main');
  removeLegacyChrome();
  const navScrim = installNavScrim(main, store);

  const topbar = createTopbar();
  const settingsDialog = createSettingsDialog();
  const importDialog = createImportDialog();
  topbar.mount(document.getElementById('topbar'), ctx);
  settingsDialog.mount(document.getElementById('settingsModal'), ctx);
  importDialog.mount(document.getElementById('importModal'), ctx);

  libraryView = createLibraryView();
  libraryView.mount(main, ctx);
  ctx.getVideo = () => (libraryView.player && libraryView.player.getVideo ? libraryView.player.getVideo() : null);

  const dashboard = createDashboardView();
  dashboard.mount(document.getElementById('dashboard'), ctx);

  const dock = createDock();
  dock.mount(main, ctx);
  const helpDialog = createHelpDialog();
  helpDialog.mount(document.body, ctx);

  /* ---------- 显式测试钩子（不恢复 ai.js 的六个隐式全局） ---------- */
  const testHook = {
    store,
    actions,
    api,
    ui,
    core,
    toast,
    dock,
    getVideo: () => ctx.getVideo(),
    getPlayer: () => libraryView.player,
  };
  window.__VDS_STORE = store;
  window.__VDS_ACTIONS = actions;
  window.__VDS = testHook;

  /* ---------- 布局状态：data-* 驱动 CSS 容器查询 ---------- */
  function applyNav(state) {
    const nav = state.ui.navDrawerOpen ? 'drawer' : state.ui.navCollapsed ? 'rail' : 'expanded';
    if (main.dataset.nav !== nav) main.dataset.nav = nav;
    document.documentElement.classList.toggle('nav-drawer-open', !!state.ui.navDrawerOpen);
  }

  /* ---------- 主渲染（各组件自己判等；ai 增量不触发整树更新） ---------- */
  let lastRefs = null;
  const unsubscribe = store.subscribe((state) => state, (state) => {
    const aiOnly = lastRefs
      && state.library === lastRefs.library
      && state.playback === lastRefs.playback
      && state.ui === lastRefs.ui
      && state.stats === lastRefs.stats;
    lastRefs = { library: state.library, playback: state.playback, ui: state.ui, stats: state.stats };

    if (aiOnly) {
      // AI 面板自己订阅 ai 切片；设置页仍需同步「测试连接」状态
      settingsDialog.update(state);
      return;
    }

    topbar.update(state);
    libraryView.update(state);
    dock.update(state);
    settingsDialog.update(state);
    importDialog.update(state);
    helpDialog.update(state);
    dashboard.update(state);
    applyNav(state);
    main.classList.toggle('hidden', state.ui.view === 'dashboard');
    document.getElementById('dashboard').classList.toggle('hidden', state.ui.view !== 'dashboard');
  });

  /* ---------- 快捷键服务（替换手写 keydown switch） ---------- */
  const shortcuts = ui.createShortcuts({
    isDialogOpen: () => !!document.querySelector('dialog[open]'),
  });
  const noDialog = () => !document.querySelector('dialog[open]');

  shortcuts.register('mod+k', () => topbar.focusSearch(), { scope: 'global', when: noDialog });
  shortcuts.register('mod+i', () => store.dispatch('toggleDock', 'ai'), { scope: 'global', when: noDialog });
  shortcuts.register('?', () => store.dispatch('setHelpOpen', true), { scope: 'global', when: noDialog });
  shortcuts.register('escape', () => {
    const state = store.get();
    if (state.ui.navDrawerOpen) {
      store.dispatch('setNavDrawerOpen', false);
      return;
    }
    if (state.ui.dockOpen) {
      store.dispatch('setDockOpen', false);
      return;
    }
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) active.blur();
  }, { scope: 'global', when: noDialog });

  const playerCombo = (event) => libraryView.player.handleKey(event);
  for (const combo of ['space', 'arrowleft', 'arrowright', 'arrowup', 'arrowdown',
    'shift+arrowleft', 'shift+arrowright', 'f', 'shift+f', 'm', 'shift+m',
    'n', 'shift+n', 'p', 'shift+p']) {
    shortcuts.register(combo, playerCombo, { scope: 'player' });
  }
  for (let i = 0; i <= 9; i++) shortcuts.register(String(i), playerCombo, { scope: 'player' });
  const detachShortcuts = shortcuts.attach(document);

  /* ---------- 全局交互（只保留必要的焦点归还，不再全局 blur） ---------- */
  function onDocumentClick(event) {
    const target = event.target;
    if (!(target instanceof Element)) return;
    // 点空白/视频/分集行后收回输入框焦点：避免空格被搜索框/AI 输入框截走。
    // 不再 blur 按钮/滑块：按钮的空格由快捷键服务 preventDefault 接管。
    const active = document.activeElement;
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT')) {
      // 弹窗内部焦点由 ui/dialog 管理：打开弹窗的那次点击不能把初始焦点 blur 掉
      if (active.closest('dialog')) return;
      if (!active.contains(target) && !target.closest('input, textarea, select, dialog')) active.blur();
    }
    if (store.get().ui.navDrawerOpen && target.closest('.course-item')) {
      store.dispatch('setNavDrawerOpen', false);
    }
  }

  function onChange(event) {
    const target = event.target;
    if (target.tagName === 'SELECT' || target.type === 'range') target.blur();
  }

  function onResize() {
    topbar.update(store.get());
    applyNav(store.get());
  }

  let dragDepth = 0;
  function onDragEnter(event) {
    event.preventDefault();
    dragDepth++;
    document.getElementById('dropHint').classList.remove('hidden');
  }
  function onDragLeave(event) {
    event.preventDefault();
    if (--dragDepth <= 0) {
      dragDepth = 0;
      document.getElementById('dropHint').classList.add('hidden');
    }
  }
  async function onDrop(event) {
    event.preventDefault();
    dragDepth = 0;
    document.getElementById('dropHint').classList.add('hidden');
    const files = [...(event.dataTransfer?.files || [])];
    if (!files.length) return;
    const dropped = await api.dropPaths(files);
    if (!dropped.ok) return;
    const paths = (dropped.data || []).filter(Boolean);
    const dirs = [];
    const videos = [];
    const docs = [];
    for (const path of paths) {
      if (core.isVideoFile(path)) videos.push(path);
      else if (core.isDocFile(path)) docs.push(path);
      else dirs.push(path);
    }
    if (dirs.length) store.dispatch('openImport', { type: 'folder', dirs });
    else if (videos.length) store.dispatch('openImport', { type: 'videos', files: videos, extraDocs: docs });
    else if (docs.length) store.dispatch('openImport', { type: 'docs', files: docs });
  }

  document.addEventListener('click', onDocumentClick);
  document.addEventListener('change', onChange);
  document.addEventListener('dragenter', onDragEnter);
  document.addEventListener('dragleave', onDragLeave);
  document.addEventListener('dragover', (event) => event.preventDefault());
  document.addEventListener('drop', onDrop);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      libraryView.player.flushProgress();
      persist.flush();
    }
  });
  window.addEventListener('beforeunload', () => {
    libraryView.player.flushProgress();
    persist.flush();
  });

  /* 首帧 */
  topbar.update(store.get());
  libraryView.update(store.get());
  dashboard.update(store.get());
  dock.update(store.get());
  applyNav(store.get());
  main.classList.toggle('hidden', store.get().ui.view === 'dashboard');
  document.getElementById('dashboard').classList.toggle('hidden', store.get().ui.view !== 'dashboard');

  await actions.bootstrap();
  if (!loaded.ok) toast.show('读取本地数据失败，已使用空库启动');
  window.__VDS_READY = true;

  return {
    store,
    actions,
    destroy() {
      unsubscribe();
      detachShortcuts();
      topbar.destroy();
      settingsDialog.destroy();
      importDialog.destroy();
      dock.destroy();
      helpDialog.destroy();
      libraryView.destroy();
      dashboard.destroy();
      navScrim.remove();
      document.removeEventListener('click', onDocumentClick);
      document.removeEventListener('change', onChange);
      document.removeEventListener('dragenter', onDragEnter);
      document.removeEventListener('dragleave', onDragLeave);
      document.removeEventListener('drop', onDrop);
      window.removeEventListener('resize', onResize);
      delete window.__VDS_STORE;
      delete window.__VDS_ACTIONS;
      delete window.__VDS;
      delete window.__VDS_READY;
    },
  };
}
