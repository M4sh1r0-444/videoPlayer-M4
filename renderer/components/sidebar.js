/**
 * 科目 / 课程侧栏（P2）。单击选中课程，右键重新匹配讲义。
 * 结构/class 与 v0.4.4 保持一致；只在课程树结构变化时重建节点。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';

export function createSidebar() {
  let tree = null;
  let ctx = null;
  let unsubscribe = null;
  let lastSubjects = null;
  let lastVideos = null;
  let lastCourseKey = null;
  const collapsed = new Set();
  const courseNodes = new Map(); // key -> { el, prog, title }

  function courseStats(course, videos) {
    let done = 0;
    for (const ep of course.episodes || []) if (videos[ep.path]?.completed) done++;
    return { done, total: (course.episodes || []).length };
  }

  function makeCourseItem(course, videos) {
    const title = h('span', {
      class: 'c-name',
      text: course.name,
      title: course.path || course.name,
    });
    const icon = h('span', { class: 'c-ico', text: (course.name || '?').slice(0, 1), 'aria-hidden': 'true' });
    const progress = h('span', { class: 'c-prog' });
    const el = h('div', {
      class: 'course-item',
      role: 'treeitem',
      tabindex: '0',
      'aria-selected': 'false',
      title: course.path || course.name,
      'aria-label': course.name,
      dataset: { courseKey: course.key },
    }, [icon, title, progress]);
    const stats = courseStats(course, videos);
    progress.textContent = `${stats.done}/${stats.total}`;
    courseNodes.set(course.key, { el, prog: progress, title });
    return el;
  }

  function rebuild(subjects, videos, courseKey) {
    const scrollTop = tree.scrollTop;
    tree.replaceChildren();
    courseNodes.clear();
    if (!subjects.length) {
      tree.append(h('div', { class: 'ep-empty sidebar-empty' }, [
        h('span', { class: 'ep-empty-icon' }, [svgIcon('folder', { size: 22 })]),
        h('strong', { class: 'ep-empty-title', text: '还没有科目' }),
        h('span', { class: 'ep-empty-sub', text: '从右上角添加学习目录' }),
      ]));
      return;
    }
    for (const subject of subjects) {
      const isCollapsed = collapsed.has(subject.name);
      const div = h('div', {
        class: 'subject',
        role: 'group',
        dataset: { subjectName: subject.name },
      });
      if (isCollapsed) div.classList.add('collapsed');
      const head = h('div', {
        class: 'subject-name',
        role: 'treeitem',
        tabindex: '0',
        title: subject.name,
        'aria-expanded': isCollapsed ? 'false' : 'true',
        'aria-label': subject.name,
      }, [
        h('span', { class: 's-ico', text: (subject.name || '?').slice(0, 1), 'aria-hidden': 'true' }),
        h('span', { class: 'arrow arrow-ico' }, [svgIcon('chevron', { size: 12 })]),
        h('span', { class: 's-name', text: subject.name }),
      ]);
      div.append(head);
      for (const course of subject.courses) div.append(makeCourseItem(course, videos));
      tree.append(div);
    }
    applyActive(courseKey);
    tree.scrollTop = scrollTop;
  }

  function applyActive(courseKey) {
    lastCourseKey = courseKey;
    for (const [key, node] of courseNodes) {
      const active = key === courseKey;
      node.el.classList.toggle('active', active);
      node.el.setAttribute('aria-selected', active ? 'true' : 'false');
    }
  }

  function updateCourseStats(state) {
    for (const subject of state.library.subjects) {
      for (const course of subject.courses) {
        const node = courseNodes.get(course.key);
        if (!node) continue;
        const stats = courseStats(course, state.library.videos);
        const text = `${stats.done}/${stats.total}`;
        if (node.prog.textContent !== text) node.prog.textContent = text;
        if (node.title.getAttribute('title') !== (course.path || course.name)) {
          node.title.setAttribute('title', course.path || course.name);
        }
      }
    }
  }

  function toggleSubject(head) {
    const subjectEl = head.closest('.subject');
    const name = subjectEl?.dataset.subjectName;
    if (!name) return;
    const isCollapsed = subjectEl.classList.toggle('collapsed');
    head.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
    if (isCollapsed) collapsed.add(name);
    else collapsed.delete(name);
  }

  function selectCurrent(item) {
    const location = findLocation(item.dataset.courseKey);
    if (location) ctx.store.dispatch('selectCourse', location.subject, location.course);
  }

  function onTreeClick(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    const head = target.closest('.subject-name');
    if (head) {
      toggleSubject(head);
      return;
    }
    const item = target.closest('.course-item');
    if (!item) return;
    selectCurrent(item);
  }

  function onTreeKey(event) {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const head = target.closest('.subject-name');
    if (head) {
      event.preventDefault();
      toggleSubject(head);
      return;
    }
    const item = target.closest('.course-item');
    if (item) {
      event.preventDefault();
      selectCurrent(item);
    }
  }

  function onTreeContextMenu(event) {
    const item = event.target instanceof Element ? event.target.closest('.course-item') : null;
    if (!item) return;
    event.preventDefault();
    const location = findLocation(item.dataset.courseKey);
    if (location) ctx.store.dispatch('refreshDocMatch', location.course);
  }

  function findLocation(key) {
    const state = ctx.store.get();
    for (const subject of state.library.subjects) {
      const course = subject.courses.find((c) => c.key === key);
      if (course) return { subject, course };
    }
    return null;
  }

  function mount(el, context) {
    tree = el;
    ctx = context;
    tree.addEventListener('click', onTreeClick);
    tree.addEventListener('keydown', onTreeKey);
    tree.addEventListener('contextmenu', onTreeContextMenu);
    return { update, destroy };
  }

  function update(state) {
    const courseKey = state.library.course ? state.library.course.key : null;
    if (state.library.subjects !== lastSubjects) {
      rebuild(state.library.subjects, state.library.videos, courseKey);
      lastSubjects = state.library.subjects;
      lastVideos = state.library.videos;
      return;
    }
    if (state.library.videos !== lastVideos) {
      updateCourseStats(state);
      lastVideos = state.library.videos;
    }
    if (courseKey !== lastCourseKey) applyActive(courseKey);
  }

  function destroy() {
    tree?.removeEventListener('click', onTreeClick);
    tree?.removeEventListener('keydown', onTreeKey);
    tree?.removeEventListener('contextmenu', onTreeContextMenu);
    unsubscribe?.();
  }

  return { mount, update, destroy };
}
