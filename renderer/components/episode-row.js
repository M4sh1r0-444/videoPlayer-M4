/**
 * 单行分集（P3）：两行式布局。
 *
 * ┌───────────────────────────────────────────┐
 * │ ✔  12  标题（最多两行）              讲义 打开 │
 * │         39:57 · 已看 88% · 已转             │
 * └───────────────────────────────────────────┘
 *
 * 只负责节点结构与最小写入，不绑定任何事件、不读 store；事件由 episode-list 委托。
 * 行内保留 data-path / data-index / data-act 测试钩子。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { fmtTime, progressState } from '../core/index.js';

const parts = new WeakMap();

/** 行右侧文本：时长 + 完成度（与 v0.4.4 语义一致） */
export function progressText(record, fallbackDuration) {
  const stateName = progressState(record);
  const duration = Number(record?.duration ?? fallbackDuration) || 0;
  const durationText = duration ? fmtTime(duration) : '';
  const position = Number(record?.position) || 0;
  const percent = stateName === 'done'
    ? '100%'
    : stateName === 'partial' && duration > 0
      ? Math.round((position / duration) * 100) + '%'
      : '';
  const progressLabel = stateName === 'done'
    ? '已完成'
    : percent ? `已看 ${percent}` : '';
  return [durationText, progressLabel].filter(Boolean).join(' · ');
}

function setText(el, value) {
  const text = String(value ?? '');
  if (el.textContent !== text) el.textContent = text;
}

function setAttr(el, name, value) {
  if (el.getAttribute(name) !== value) el.setAttribute(name, value);
}

function makeButton(className, text, title, act, label) {
  const button = h('button', {
    class: className,
    type: 'button',
    title,
    text,
    dataset: { act },
  });
  if (label) button.setAttribute('aria-label', label);
  return button;
}

export function createRow() {
  const st = h('span', { class: 'st', 'aria-hidden': 'true' }, [
    svgIcon('circle', { size: 11, className: 'st-icon st-off' }),
    svgIcon('play', { size: 11, className: 'st-icon st-partial' }),
    svgIcon('check', { size: 13, className: 'st-icon st-done' }),
  ]);
  const idx = h('span', { class: 'idx', 'aria-hidden': 'true' });
  const title = h('span', { class: 'title' });
  const pct = h('span', { class: 'pct' });
  const docSlot = h('span', { class: 'ep-doc-slot' });
  const actions = h('div', { class: 'ep-actions' }, [
    docSlot,
    makeButton('row-btn', '打开', '打开所在文件夹', 'reveal', '打开分集所在文件夹'),
  ]);
  const meta = h('div', { class: 'ep-meta' }, [pct, actions]);
  const main = h('div', { class: 'ep-main' }, [title, meta]);
  const row = h('div', {
    class: 'ep-row',
    role: 'option',
    tabindex: '-1',
    'aria-selected': 'false',
  });
  row.append(st, idx, main);
  parts.set(row, { st, idx, title, pct, meta, docSlot, actions, doc: null, remux: null, open: actions.lastElementChild });
  return row;
}

const docButton = (doc) => {
  const btn = makeButton('row-btn doc-btn', '讲义', doc.name, 'doc', `打开讲义 ${doc.name}`);
  btn.dataset.docPath = doc.path;
  return btn;
};

const remuxBadge = () => h('span', { class: 'row-ico', title: '已转封装，可直接内播', text: '已转', 'aria-label': '已转封装' });

/**
 * @param {HTMLElement} row
 * @param {{ep:any,index:number,record:any,doc:any,remux:boolean,active:boolean}} item
 */
export function updateRow(row, item) {
  const p = parts.get(row);
  if (!p) return;
  const { ep, index, record, doc, remux, active } = item;
  const progress = progressState(record);
  const cls = 'ep-row'
    + (active ? ' active' : '')
    + (progress === 'done' ? ' done' : progress === 'partial' ? ' partial' : '');
  if (row.className !== cls) row.className = cls;
  if (row.dataset.path !== ep.path) row.dataset.path = ep.path;
  if (row.dataset.index !== String(index)) row.dataset.index = String(index);
  setAttr(row, 'aria-selected', active ? 'true' : 'false');

  setText(p.idx, index + 1);
  setText(p.title, ep.title);
  setAttr(p.title, 'title', ep.filename + (ep.playable ? '' : '\n（此格式需用系统播放器打开）'));
  const pctText = progressText(record);
  setText(p.pct, pctText);

  if (doc) {
    if (!p.doc) {
      p.doc = docButton(doc);
      p.docSlot.append(p.doc);
    } else {
      setAttr(p.doc, 'title', doc.name);
      setAttr(p.doc, 'aria-label', `打开讲义 ${doc.name}`);
      if (p.doc.dataset.docPath !== doc.path) p.doc.dataset.docPath = doc.path;
    }
  } else if (p.doc) {
    p.doc.remove();
    p.doc = null;
  }

  if (remux) {
    if (!p.remux) {
      p.remux = remuxBadge();
      p.meta.append(p.remux);
    }
  } else if (p.remux) {
    p.remux.remove();
    p.remux = null;
  }
}
