/**
 * 讲义页签（P3）：从旧 docs-menu 浮层迁移到 dock。
 * 保留自动匹配 / 手动关联 / 移除 / 刷新匹配 / 点击用系统程序打开。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';

export function createDocsPanel() {
  let root = null;
  let list = null;
  let refreshBtn = null;
  let ctx = null;
  let lastCourse = null;
  let lastDocs = null;
  let lastIndex = null;

  function render(state) {
    const course = state.library.course;
    const docs = course ? course.docs || [] : [];
    list.replaceChildren();
    if (!course) {
      list.append(h('div', { class: 'doc-empty' }, [
        h('span', { class: 'doc-empty-icon' }, [svgIcon('book', { size: 22 })]),
        h('strong', { class: 'doc-empty-title', text: '先选择一门课程' }),
        h('span', { class: 'doc-empty-sub', text: '当前课程的讲义会显示在这里' }),
      ]));
      return;
    }
    if (!docs.length) {
      list.append(h('div', { class: 'doc-empty' }, [
        h('span', { class: 'doc-empty-icon' }, [svgIcon('book', { size: 22 })]),
        h('strong', { class: 'doc-empty-title', text: '本课程暂无讲义/习题' }),
        h('span', { class: 'doc-empty-sub' }, [
          '把 PDF 等文件放进课程文件夹，', h('br'),
          '或用「导入 → 讲义习题」添加',
        ]),
      ]));
      return;
    }
    const canBind = state.playback.index >= 0;
    const nodes = [];
    for (const doc of docs) {
      const scope = doc.episodeIndex == null ? '课程资料' : `第 ${doc.episodeIndex + 1} 集`;
      const actions = h('span', { class: 'd-actions' });
      if (canBind) {
        actions.append(h('button', {
          class: 'd-btn',
          type: 'button',
          dataset: { act: 'bind', docPath: doc.path },
          text: '关联',
          title: `关联到当前分集（第 ${state.playback.index + 1} 集）`,
          'aria-label': `关联讲义 ${doc.name} 到当前分集`,
        }));
      }
      actions.append(h('button', {
        class: 'd-btn',
        type: 'button',
        dataset: { act: 'del', docPath: doc.path },
        title: '从本课程移除（重启不复活）',
        'aria-label': `移除讲义 ${doc.name}`,
      }, [svgIcon('close', { size: 14 })]));
      const item = h('div', {
        class: 'doc-item',
        role: 'listitem',
        tabindex: '0',
        dataset: { docPath: doc.path },
        'aria-label': `${doc.name}，${scope}，回车打开`,
      }, [
        h('span', { class: 'd-name', text: doc.name, title: doc.path }),
        h('span', { class: 'd-scope', text: scope }),
        actions,
      ]);
      nodes.push(item);
    }
    list.append(...nodes);
  }

  function onClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('#docRefresh')) {
      const course = ctx.store.get().library.course;
      if (course) ctx.store.dispatch('refreshDocMatch', course);
      return;
    }
    const button = target.closest('.d-btn');
    if (button) {
      event.stopPropagation();
      const state = ctx.store.get();
      const course = state.library.course;
      const doc = course ? (course.docs || []).find((d) => d.path === button.dataset.docPath) : null;
      if (!doc) return;
      if (button.dataset.act === 'bind') ctx.store.dispatch('bindDoc', doc);
      else if (button.dataset.act === 'del') ctx.store.dispatch('removeDoc', doc);
      return;
    }
    const item = target.closest('.doc-item');
    if (item) ctx.api.openPath(item.dataset.docPath);
  }

  function onKeyDown(event) {
    const item = event.target instanceof Element ? event.target.closest('.doc-item') : null;
    if (!item || event.target !== item) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      ctx.api.openPath(item.dataset.docPath);
    }
  }

  function sync(state) {
    const course = state.library.course;
    const docs = course ? course.docs : null;
    const index = state.playback.index;
    if (lastCourse === course && lastDocs === docs && lastIndex === index) return;
    lastCourse = course;
    lastDocs = docs;
    lastIndex = index;
    render(state);
  }

  function mount(container, context) {
    ctx = context;
    refreshBtn = h('button', {
      id: 'docRefresh',
      class: 'mini-btn',
      type: 'button',
      title: '重新匹配讲义到分集',
      text: '刷新匹配',
    });
    list = h('div', { id: 'docsList', class: 'docs-list', role: 'list', 'aria-label': '讲义与习题' });
    root = h('div', { id: 'dockDocsPanel', class: 'docs-panel' }, [
      h('div', { class: 'docs-head' }, [h('span', { text: '讲义 / 习题' }), refreshBtn]),
      list,
      h('div', { class: 'docs-hint', text: '讲义按「第X讲 / 集 / 课」自动匹配，关联后也可手动调整。' }),
    ]);
    container.append(root);
    root.addEventListener('click', onClick);
    root.addEventListener('keydown', onKeyDown);
    return { update: sync, destroy, focus: () => refreshBtn.focus() };
  }

  function destroy() {
    root?.removeEventListener('click', onClick);
    root?.removeEventListener('keydown', onKeyDown);
    root?.remove();
    root = null;
    list = null;
  }

  return { mount, destroy, update: sync, focus: () => refreshBtn?.focus() };
}
