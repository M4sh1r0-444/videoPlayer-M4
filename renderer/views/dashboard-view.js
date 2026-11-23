/**
 * 学习看板（P2）：保持 v0.4.4 的结构、class 与数据口径，仅改为增量状态驱动的渲染。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { fmtDur, fmtTime } from '../core/index.js';
import { continueItem, subjectStats, weekStats } from '../data/selectors.js';

export function createDashboardView() {
  let ctx = null;
  let rendered = false;
  let wasVisible = false;
  let lastKey = null;
  let renderSeq = 0;

  function renderContinue(state) {
    const box = document.getElementById('dashContinue');
    const item = continueItem(state);
    box.replaceChildren(h('div', { class: 'dash-sec-title', text: '继续学习' }));
    if (!item) {
      box.append(h('div', { class: 'cont-none', text: '没有待续播的分集，去左侧挑一集开始吧' }));
      return;
    }
    const { subject, course, ep, index, record, percent } = item;
    const sub = `第 ${index + 1} 集 / 共 ${course.episodes.length} 集 · 已看 ${fmtTime(record.position)}（${percent}%）`;
    const card = h('div', { class: 'cont-card', id: 'contCard' }, [
      h('div', { class: 'cont-noimg', id: 'contNoImg', text: '暂无预览' }),
      h('img', { id: 'contThumb', class: 'hidden', alt: '' }),
      h('div', { class: 'cont-info' }, [
        h('div', { class: 'cont-course', text: course.name }),
        h('div', { class: 'cont-title', text: ep.title }),
        h('div', { class: 'cont-sub', text: sub }),
        h('progress', { class: 'cont-bar', max: 100, value: percent }),
      ]),
      h('button', { class: 'big-btn cont-cta' }, [
        svgIcon('play', { size: 18 }),
        h('span', { text: '继续播放' }),
      ]),
    ]);
    card.addEventListener('click', () => {
      ctx.store.dispatch('setView', 'library');
      ctx.store.dispatch('selectCourse', subject, course, index, { autoplay: true });
    });
    box.append(card);

    const seq = ++renderSeq;
    (async () => {
      const result = await ctx.api.episodeMeta({
        path: ep.path,
        thumb: true,
        duration: true,
        durationHint: record.duration,
      });
      if (!result.ok || !result.data?.thumbPath || seq !== renderSeq) return;
      if (state.ui.view !== 'dashboard') return;
      const img = document.getElementById('contThumb');
      if (!img) return;
      const url = ctx.api.mediaUrl(result.data.thumbPath);
      if (!url.ok) return;
      img.src = url.data;
      img.classList.remove('hidden');
      document.getElementById('contNoImg')?.classList.add('hidden');
    })();
  }

  function renderSubjects(state) {
    const box = document.getElementById('dashSubjects');
    const nodes = [h('div', { class: 'dash-sec-title', text: '科目进度' })];
    for (const subject of state.library.subjects) {
      const stats = subjectStats(state, subject);
      const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;
      nodes.push(h('div', { class: 'subj-row' }, [
        h('span', { class: 's-name', text: subject.name }),
        h('progress', { class: 's-bar', max: 100, value: pct }),
        h('span', {
          class: 's-frac' + (stats.done ? ' is-positive' : ''),
          text: `${stats.done}/${stats.total}`,
        }),
      ]));
    }
    if (!state.library.subjects.length) nodes.push(h('div', { class: 'cont-none', text: '还没有添加学习目录' }));
    box.replaceChildren(...nodes);
  }

  function renderWeek(state) {
    const week = weekStats(state);
    const box = document.getElementById('dashWeek');
    const card = (value, label, cluster = '') => h('div', { class: 'w-card' }, [
      h('div', {
        class: 'w-num' + (cluster ? ` ${cluster}` : '') + (Number(value) ? '' : ' is-zero'),
        text: cluster === 'w-dur' ? fmtDur(value) : String(value),
      }),
      h('div', { class: 'w-label', text: label }),
    ]);
    box.replaceChildren(
      h('div', { class: 'dash-sec-title', text: '本周学习' }),
      h('div', { class: 'week-cards' }, [
        card(week.activeDays, '活跃天数'),
        card(week.doneWeek, '看完集数'),
        card(week.weekSec, '累计观看', 'w-dur'),
        card(week.todaySec, '今日时长', 'w-dur'),
      ]),
    );
  }

  function mount(container, context) {
    ctx = context;
    return { update, destroy };
  }

  function update(state) {
    const visible = state.ui.view === 'dashboard';
    if (!visible) {
      wasVisible = false;
      return;
    }
    const key = [
      state.library.subjects,
      state.library.videos,
      state.stats.daily,
      state.library.lastCoursePath,
      state.playback.lastEpisodePath,
    ];
    if (rendered && wasVisible && lastKey && key.every((value, index) => value === lastKey[index])) return;
    renderSeq++;
    renderContinue(state);
    renderSubjects(state);
    renderWeek(state);
    rendered = true;
    wasVisible = true;
    lastKey = key;
  }

  function destroy() {
    renderSeq++;
  }

  return { mount, update, destroy };
}
