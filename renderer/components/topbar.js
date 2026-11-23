/**
 * 顶栏（P2）：课程标题 / 进度 / 主题 / 首页 / 目录 / 导入 / 设置 / 讲义 /
 * 全局搜索。DOM 与 class 名称保持 v0.4.4。
 */

import { h } from '../ui/dom.js';
import { searchLibrary } from '../core/index.js';

export function createTopbar() {
  let el = null;
  let ctx = null;
  let unsubscribe = null;
  let input = null;
  let drop = null;
  let gsItems = [];
  let gsIndex = -1;

  function setDropVisible(show) {
    drop?.classList.toggle('hidden', !show);
    input?.setAttribute('aria-expanded', show ? 'true' : 'false');
  }

  function renderDrop() {
    if (!drop) return;
    if (!gsItems.length) {
      drop.replaceChildren(h('div', { class: 'gs-empty', text: '没有匹配的课程或分集' }));
      return;
    }
    const rows = [];
    const courses = gsItems.filter((it) => it.type === 'course');
    const eps = gsItems.filter((it) => it.type === 'ep');
    if (courses.length) {
      rows.push(h('div', { class: 'gs-group', text: '课程' }));
      courses.forEach((it) => {
        const id = gsItems.indexOf(it);
        rows.push(h('div', {
          class: 'gs-item' + (id === gsIndex ? ' on' : ''),
          role: 'option',
          'aria-selected': id === gsIndex ? 'true' : 'false',
          dataset: { id: String(id) },
        }, [
          h('span', { class: 'g-label', text: it.course.name }),
          h('span', { class: 'g-sub', text: it.subject.name }),
        ]));
      });
    }
    if (eps.length) {
      rows.push(h('div', { class: 'gs-group', text: '分集' }));
      eps.forEach((it) => {
        const id = gsItems.indexOf(it);
        rows.push(h('div', {
          class: 'gs-item' + (id === gsIndex ? ' on' : ''),
          role: 'option',
          'aria-selected': id === gsIndex ? 'true' : 'false',
          dataset: { id: String(id) },
        }, [
          h('span', { class: 'g-label', text: it.ep.title }),
          h('span', { class: 'g-sub', text: `${it.course.name} · 第 ${it.idx + 1} 集` }),
        ]));
      });
    }
    drop.replaceChildren(...rows);
  }

  function updateSearch() {
    const state = ctx.store.get();
    const result = searchLibrary(state.library.subjects, input.value);
    gsItems = result.items;
    gsIndex = gsItems.length ? 0 : -1;
    if (!result.query) {
      setDropVisible(false);
      return;
    }
    renderDrop();
    setDropVisible(true);
  }

  function hideDrop() {
    setDropVisible(false);
  }

  function exec(item) {
    setDropVisible(false);
    input.blur();
    if (!item) return;
    const { store } = ctx;
    store.dispatch('setView', 'library');
    store.dispatch('selectCourse', item.subject, item.course);
    if (item.type === 'ep') store.dispatch('playEpisode', item.idx, { autoplay: true });
  }

  function move(delta) {
    if (!gsItems.length) return;
    gsIndex = (gsIndex + delta + gsItems.length) % gsItems.length;
    renderDrop();
    drop?.querySelector('.gs-item.on')?.scrollIntoView({ block: 'nearest' });
  }

  function onHeaderClick(event) {
    const button = event.target instanceof Element ? event.target.closest('button') : null;
    if (!button) return;
    const { store } = ctx;
    switch (button.id) {
      case 'btnHome':
        store.dispatch('toggleView');
        break;
      case 'btnTheme':
        store.dispatch('setTheme', store.get().ui.theme === 'light' ? 'dark' : 'light');
        break;
      case 'btnAddDir':
        store.dispatch('addRootsFromPicker');
        break;
      case 'btnImport':
        store.dispatch('beginImportFromPicker');
        break;
      case 'btnDocs':
        store.dispatch('toggleDock', 'docs');
        break;
      case 'btnAI':
        store.dispatch('toggleDock', 'ai');
        break;
      case 'btnSettings':
        store.dispatch('setModal', 'settings');
        break;
      case 'btnNav': {
        const narrow = typeof ctx.isNarrow === 'function' ? ctx.isNarrow() : false;
        if (narrow) store.dispatch('toggleNavDrawer');
        else store.dispatch('toggleNavCollapsed');
        break;
      }
      case 'btnHelp':
        store.dispatch('setHelpOpen', true);
        break;
      default:
        break;
    }
  }

  function onSearchKey(event) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      exec(gsItems[gsIndex]);
    } else if (event.key === 'Escape') {
      hideDrop();
      input.blur();
    }
  }

  function onSearchPointer(event) {
    const item = event.target instanceof Element ? event.target.closest('.gs-item') : null;
    if (!item) return;
    event.preventDefault();
    exec(gsItems[Number(item.dataset.id)]);
  }

  function mount(container, context) {
    el = container;
    ctx = context;
    input = document.getElementById('globalSearch');
    drop = document.getElementById('searchDrop');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-autocomplete', 'list');
    input.setAttribute('aria-controls', 'searchDrop');
    input.setAttribute('aria-expanded', 'false');
    input.setAttribute('aria-label', '全局搜索');
    drop.setAttribute('role', 'listbox');
    drop.setAttribute('aria-label', '搜索结果');
    el.addEventListener('click', onHeaderClick);
    input.addEventListener('input', updateSearch);
    input.addEventListener('focus', updateSearch);
    input.addEventListener('blur', hideDrop);
    input.addEventListener('keydown', onSearchKey);
    drop.addEventListener('mousedown', onSearchPointer);
    return { update, destroy };
  }

  function update(state) {
    const course = state.library.course;
    const title = course
      ? `${course.name} · ${state.library.subject ? state.library.subject.name : ''}`
      : '';
    const titleEl = document.getElementById('courseTitle');
    if (titleEl.textContent !== title) titleEl.textContent = title;

    const chip = document.getElementById('progressChip');
    if (course && course.episodes.length) {
      let done = 0;
      for (const ep of course.episodes) if (state.library.videos[ep.path]?.completed) done++;
      const text = `已完成 ${done}/${course.episodes.length}`;
      if (chip.textContent !== text) chip.textContent = text;
      chip.setAttribute('title', `本课程已完成 ${done}/${course.episodes.length} 集`);
      chip.classList.remove('hidden');
    } else {
      chip.classList.add('hidden');
      chip.removeAttribute('title');
    }

    document.body.classList.toggle('light', state.ui.theme === 'light');
    const themeBtn = document.getElementById('btnTheme');
    const themeLabel = state.ui.theme === 'light' ? '切换到夜间模式' : '切换到白天模式';
    if (themeBtn.getAttribute('aria-label') !== themeLabel) themeBtn.setAttribute('aria-label', themeLabel);
    if (themeBtn.getAttribute('title') !== themeLabel) themeBtn.setAttribute('title', themeLabel);

    const homeBtn = document.getElementById('btnHome');
    homeBtn.classList.toggle('on', state.ui.view === 'dashboard');
    homeBtn.setAttribute('aria-pressed', state.ui.view === 'dashboard' ? 'true' : 'false');

    // 顶栏只表达「停靠区是否打开」，具体页面由 Dock 页签表达。
    const dockOpen = !!state.ui.dockOpen;
    const tools = document.getElementById('tbTools');
    tools?.classList.toggle('is-open', dockOpen);
    const aiBtn = document.getElementById('btnAI');
    const docsBtn = document.getElementById('btnDocs');
    for (const button of [aiBtn, docsBtn]) {
      if (!button) continue;
      button.setAttribute('aria-expanded', dockOpen ? 'true' : 'false');
      button.classList.remove('on');
    }

    const navBtn = document.getElementById('btnNav');
    if (navBtn) {
      const narrow = typeof ctx.isNarrow === 'function' ? ctx.isNarrow() : false;
      const expanded = narrow ? state.ui.navDrawerOpen : !state.ui.navCollapsed;
      navBtn.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      navBtn.setAttribute('aria-label', expanded ? '收起侧栏' : '展开侧栏');
      navBtn.classList.toggle('on', expanded);
    }
  }

  function destroy() {
    el?.removeEventListener('click', onHeaderClick);
    input?.removeEventListener('input', updateSearch);
    input?.removeEventListener('focus', updateSearch);
    input?.removeEventListener('blur', hideDrop);
    input?.removeEventListener('keydown', onSearchKey);
    drop?.removeEventListener('mousedown', onSearchPointer);
    unsubscribe?.();
  }

  return { mount, update, destroy, focusSearch: () => { input.focus(); input.select(); }, updateSearch };
}
