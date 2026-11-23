/**
 * 快捷键帮助（P3）：按 `?` 打开，Esc / 背板 / 关闭按钮关闭。
 * 用原生 <dialog> + ui/dialog，焦点陷阱与焦点归还由基础设施负责。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';

const GROUPS = [
  {
    title: '播放',
    rows: [
      ['Space', '播放 / 暂停'],
      ['← / →', '快退 / 快进 5 秒（Shift 为 30 秒）'],
      ['↑ / ↓', '音量 ±5%'],
      ['F / 双击画面', '全屏'],
      ['M', '静音 / 取消静音'],
      ['N / P', '下一集 / 上一集'],
      ['0–9', '跳到 0%–90%'],
    ],
  },
  {
    title: '全局',
    rows: [
      ['Ctrl+K', '聚焦全局搜索'],
      ['Ctrl+I', '打开 / 关闭 AI 页签'],
      ['?', '打开本帮助'],
      ['Esc', '关闭弹窗 / 停靠区浮层'],
    ],
  },
  {
    title: '列表 / 侧栏',
    rows: [
      ['Tab', '在按钮、侧栏、分集列表间移动'],
      ['↑ / ↓', '在分集列表中移动（列表获得焦点时）'],
      ['Enter', '选课 / 播放当前分集'],
      ['双击分隔条', '恢复默认栏宽（旧界面）'],
    ],
  },
];

export function createHelpDialog() {
  let dialogEl = null;
  let dialog = null;
  let ctx = null;
  let isOpen = false;

  function build() {
    const body = h('div', { class: 'help-body' });
    body.append(h('p', { class: 'help-lede', text: '所有快捷键在输入框聚焦时不会触发，避免影响文字输入。' }));
    for (const group of GROUPS) {
      const table = h('table', { class: 'help-table' }, [
        h('caption', { text: group.title }),
        h('tbody', {}, group.rows.map(([key, desc]) => h('tr', {}, [
          h('th', { scope: 'row' }, [h('kbd', { text: key })]),
          h('td', { text: desc }),
        ]))),
      ]);
      body.append(table);
    }
    dialogEl = h('dialog', {
      id: 'helpDialog',
      class: 'modal help-modal',
      role: 'dialog',
      'aria-modal': 'true',
      'aria-labelledby': 'helpTitle',
    }, [
      h('div', { class: 'modal-card help-card' }, [
        h('div', { class: 'modal-title help-title' }, [
          svgIcon('help', { size: 18 }),
          h('span', { id: 'helpTitle', text: '快捷键' }),
        ]),
        body,
        h('div', { class: 'modal-foot' }, [
          h('button', { id: 'helpClose', class: 'btn primary', type: 'button', text: '知道了', onclick: () => ctx.store.dispatch('setHelpOpen', false) }),
        ]),
      ]),
    ]);
    document.body.append(dialogEl);
    dialog = ctx.ui.createDialog(dialogEl, {
      closeOnBackdrop: true,
      initialFocus: '#helpClose',
      onClose: () => {
        if (ctx.store.get().ui.helpOpen) ctx.store.dispatch('setHelpOpen', false);
      },
    });
  }

  function mount(container, context) {
    ctx = context;
    if (!dialogEl) build();
  }

  function update(state) {
    const open = !!state.ui.helpOpen;
    if (open && !isOpen) {
      isOpen = true;
      dialog.show();
    } else if (!open && isOpen) {
      isOpen = false;
      dialog.close();
    }
  }

  function destroy() {
    dialog = null;
    dialogEl?.remove();
    dialogEl = null;
  }

  return { mount, update, destroy };
}
