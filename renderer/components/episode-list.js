/**
 * 分集列表（P2）。
 *
 * - keyed 增量更新：复用行节点，进度变化只写变化行；
 * - click 事件委托：列表容器只挂 1 个 click 监听，行内不绑定；
 * - 时长懒加载：IntersectionObserver 只探列表可视区（约 12 行），滚动续探；
 * - 悬停预览元信息用 100 条内存 LRU。
 */

import { h } from '../ui/dom.js';
import { svgIcon } from '../ui/icon.js';
import { patchRows } from '../ui/list-patch.js';
import { createLru } from '../ui/lru.js';
import { fmtTime } from '../core/index.js';
import { createRow, updateRow } from './episode-row.js';

const PREVIEW_DELAY = 300;

export function createEpisodeList() {
  let container = null;
  let panel = null;
  let ctx = null;
  let unsubscribe = null;
  let io = null;
  let courseKey = null;
  let generation = 0;
  let probeQueue = [];
  let pumping = false;
  const probing = new Set();
  const failed = new Set();
  const metaCache = createLru(100);

  let hoverTimer = null;
  let hoverPath = null;
  let previewPath = null;
  let emptyMode = null;
  let emptyNode = null;

  const preview = () => document.getElementById('hoverPreview');
  const previewImg = () => document.getElementById('hpImg');
  const previewNoImg = () => document.getElementById('hpNoImg');
  const previewName = () => document.getElementById('hpName');
  const previewSub = () => document.getElementById('hpSub');

  function hidePreview() {
    hoverPath = null;
    clearTimeout(hoverTimer);
    hoverTimer = null;
    preview()?.classList.add('hidden');
  }

  function setPreviewImg(thumbPath) {
    const img = previewImg();
    const noImg = previewNoImg();
    if (!img) return;
    if (thumbPath) {
      const url = ctx.api.mediaUrl(thumbPath);
      if (url.ok) {
        if (img.getAttribute('src') !== url.data) img.src = url.data;
        img.classList.remove('hidden');
        noImg?.classList.add('hidden');
        return;
      }
    }
    img.classList.add('hidden');
    img.removeAttribute('src');
    noImg?.classList.remove('hidden');
  }

  function currentEp(path) {
    const course = ctx.store.get().library.course;
    return course ? course.episodes.find((ep) => ep.path === path) : null;
  }

  async function showPreview(path) {
    if (hoverPath !== path) return;
    const state = ctx.store.get();
    const ep = currentEp(path);
    if (!ep || !state.library.course) return;
    previewPath = path;
    const box = preview();
    box?.classList.remove('hidden');
    if (previewName()) previewName().textContent = ep.filename;
    const known = state.library.videos[path]?.duration;
    if (previewSub()) previewSub().textContent = known ? `时长 ${fmtTime(known)} · ${state.library.course.name}` : state.library.course.name;

    let meta = metaCache.get(path);
    setPreviewImg(meta?.thumbPath || null);
    if (meta?.thumbPath || meta?.noThumb) return;

    const result = await ctx.api.episodeMeta({ path, thumb: true, duration: false, durationHint: known });
    if (hoverPath !== path) return;
    const r = result.ok ? result.data : null;
    meta = {
      ...(meta || {}),
      thumbPath: r?.thumbPath || null,
      duration: r?.duration ?? meta?.duration,
      noThumb: !r?.thumbPath,
    };
    metaCache.set(path, meta);
    if ((r?.duration ?? 0) > 0) {
      if (!known) ctx.store.dispatch('setEpisodeDuration', path, r.duration);
      if (previewSub()) previewSub().textContent = `时长 ${fmtTime(r.duration)} · ${state.library.course.name}`;
    }
    setPreviewImg(r?.thumbPath || null);
  }

  function onMouseOver(event) {
    const row = event.target instanceof Element ? event.target.closest('.ep-row') : null;
    if (!row || !container.contains(row) || row.dataset.path === hoverPath) return;
    hoverPath = row.dataset.path;
    clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => showPreview(hoverPath), PREVIEW_DELAY);
  }

  function hideForPreviewError() {
    const m = previewPath ? metaCache.get(previewPath) : null;
    if (previewPath && m?.thumbPath) {
      m.thumbPath = null;
      m.noThumb = false;
      if (hoverPath === previewPath) showPreview(previewPath);
      return;
    }
    previewImg()?.classList.add('hidden');
    previewNoImg()?.classList.remove('hidden');
  }

  function onListClick(event) {
    const row = event.target instanceof Element ? event.target.closest('.ep-row') : null;
    if (!row || !container.contains(row)) return;
    hidePreview();
    const actionEl = event.target instanceof Element ? event.target.closest('[data-act]') : null;
    if (actionEl) {
      if (actionEl.dataset.act === 'doc') {
        const docPath = actionEl.dataset.docPath;
        if (docPath) ctx.api.openPath(docPath);
      } else if (actionEl.dataset.act === 'reveal') {
        ctx.api.reveal(row.dataset.path);
      }
      return;
    }
    ctx.store.dispatch('playEpisode', Number(row.dataset.index));
  }

  /* ---------- 键盘：roving tabindex + ↑↓/Home/End/Enter ---------- */

  function rows() {
    return [...container.querySelectorAll('.ep-row')];
  }

  function tabbableRow() {
    const all = rows();
    return all.find((row) => row.classList.contains('active')) || all[0] || null;
  }

  function syncTabbables() {
    const target = tabbableRow();
    for (const row of rows()) {
      const value = row === target ? 0 : -1;
      // 直接赋相同值也可能写 tabindex 属性，触发 MutationObserver 假阳性
      if (row.tabIndex !== value) row.tabIndex = value;
    }
  }

  function focusRow(row) {
    if (!row) return;
    row.focus();
  }

  function onListKey(event) {
    if (event.target instanceof Element && event.target.closest('[data-act]')) return;
    const row = event.target instanceof Element ? event.target.closest('.ep-row') : null;
    if (!row) {
      if (event.target === container) {
        const target = tabbableRow();
        if (target) {
          event.preventDefault();
          focusRow(target);
        }
      }
      return;
    }
    const all = rows();
    const index = all.indexOf(row);
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        event.stopPropagation();
        focusRow(all[Math.min(all.length - 1, index + 1)]);
        break;
      case 'ArrowUp':
        event.preventDefault();
        event.stopPropagation();
        focusRow(all[Math.max(0, index - 1)]);
        break;
      case 'Home':
        event.preventDefault();
        event.stopPropagation();
        focusRow(all[0]);
        break;
      case 'End':
        event.preventDefault();
        event.stopPropagation();
        focusRow(all[all.length - 1]);
        break;
      case 'Enter':
        event.preventDefault();
        event.stopPropagation();
        hidePreview();
        ctx.store.dispatch('playEpisode', Number(row.dataset.index));
        break;
      default:
        break;
    }
  }

  function onListFocus(event) {
    if (event.target !== container) return;
    focusRow(tabbableRow());
  }

  function emptyMessage(textLines) {
    const node = h('div', { class: 'ep-empty ep-empty-list' }, [
      h('span', { class: 'ep-empty-icon' }, [svgIcon('play', { size: 18 })]),
      h('strong', { class: 'ep-empty-title', text: textLines[0] }),
      h('span', { class: 'ep-empty-sub' }, textLines.slice(1).flatMap((line, i) => (i ? [h('br'), line] : [line]))),
    ]);
    return node;
  }

  function showEmpty(lines) {
    emptyMode = lines.join('\n');
    emptyNode = emptyMessage(lines);
    io?.disconnect();
    container.replaceChildren(emptyNode);
  }

  function ensureEmpty(lines) {
    const key = lines.join('\n');
    if (emptyMode === key && emptyNode && container.firstElementChild === emptyNode) return;
    showEmpty(lines);
  }

  function clearEmpty() {
    if (emptyMode == null) return;
    emptyMode = null;
    emptyNode = null;
    container.replaceChildren();
  }

  function buildItems(state) {
    const course = state.library.course;
    if (!course) return [];
    const filter = state.library.filterText.trim().toLowerCase();
    const docsByIndex = new Map();
    for (const doc of course.docs || []) if (doc.episodeIndex != null) docsByIndex.set(doc.episodeIndex, doc);
    const items = [];
    for (let index = 0; index < course.episodes.length; index++) {
      const ep = course.episodes[index];
      if (filter && !ep.title.toLowerCase().includes(filter) && !ep.filename.toLowerCase().includes(filter)) continue;
      items.push({
        ep,
        index,
        record: state.library.videos[ep.path],
        doc: docsByIndex.get(index) || null,
        remux: !!state.library.remuxReady[ep.path],
        active: state.playback.index === index,
      });
    }
    return items;
  }

  function observeVisibleRows() {
    if (!io) return;
    for (const row of container.querySelectorAll('.ep-row')) {
      const path = row.dataset.path;
      if (!path) continue;
      const state = ctx.store.get();
      if ((state.library.videos[path]?.duration ?? 0) > 0) continue;
      if (failed.has(path)) continue;
      io.observe(row);
    }
  }

  function enqueueDuration(path) {
    if (!ctx || !path || probing.has(path) || failed.has(path)) return;
    const state = ctx.store.get();
    if ((state.library.videos[path]?.duration ?? 0) > 0) return;
    probing.add(path);
    probeQueue.push({ path, gen: generation });
    pumpDurations();
  }

  async function pumpDurations() {
    if (pumping) return;
    pumping = true;
    try {
      while (probeQueue.length) {
        const job = probeQueue.shift();
        if (job.gen !== generation) {
          probing.delete(job.path);
          continue;
        }
        const result = await ctx.api.episodeMeta({ path: job.path, thumb: false, duration: true });
        if (job.gen !== generation) {
          probing.delete(job.path);
          continue;
        }
        if (result.ok && Number(result.data?.duration) > 0) {
          const path = job.path;
          const duration = Number(result.data.duration);
          metaCache.set(path, { ...(metaCache.get(path) || {}), duration });
          ctx.store.dispatch('setEpisodeDuration', path, duration);
          const row = container.querySelector(`.ep-row[data-path="${CSS.escape(path)}"]`);
          if (row) io?.unobserve(row);
        } else {
          failed.add(job.path);
        }
        probing.delete(job.path);
      }
    } finally {
      pumping = false;
      if (probeQueue.length) pumpDurations();
    }
  }

  function onIntersect(entries) {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const path = entry.target.dataset?.path;
      if (path) enqueueDuration(path);
    }
  }

  function ensureObserver() {
    if (io) return;
    if (typeof IntersectionObserver !== 'function') return;
    // 只取滚动容器上方 55% 作为观察区：1344×821 下约 12~13 行，滚动再续探
    io = new IntersectionObserver(onIntersect, {
      root: container,
      rootMargin: '0px 0px -45% 0px',
      threshold: 0.01,
    });
  }

  function resetCourse(course) {
    generation++;
    probeQueue = [];
    probing.clear();
    failed.clear();
    io?.disconnect();
    courseKey = course ? course.key : null;
    hidePreview();
  }

  function mount(el, context) {
    container = el;
    panel = el.parentElement || el;
    ctx = context;
    ensureObserver();
    container.addEventListener('click', onListClick);
    container.addEventListener('keydown', onListKey);
    container.addEventListener('focusin', onListFocus);
    panel.addEventListener('mouseover', onMouseOver);
    panel.addEventListener('mouseleave', hidePreview);
    previewImg()?.addEventListener('error', hideForPreviewError);
    return { update, destroy, hidePreview, metaCache };
  }

  function update(state) {
    const course = state.library.course;
    const key = course ? course.key : null;
    if (key !== courseKey) resetCourse(course);
    if (!course) {
      // 空库或尚未选课：给分集栏一个轻量、可理解的下一步，而不是一整块空白。
      ensureEmpty(['选择一门课程', '从左侧科目树开始']);
      return;
    }
    if (!course.episodes.length) {
      ensureEmpty(['该课程暂无视频', '下载后放入文件夹，或用「导入」手动添加']);
      return;
    }
    clearEmpty();
    const items = buildItems(state);
    patchRows(container, items, {
      key: (item) => item.ep.path,
      create: () => createRow(),
      update: (node, item) => updateRow(node, item),
    });
    syncTabbables();
    observeVisibleRows();
    if (hoverPath && !items.some((item) => item.ep.path === hoverPath)) hidePreview();
  }

  function destroy() {
    container?.removeEventListener('click', onListClick);
    container?.removeEventListener('keydown', onListKey);
    container?.removeEventListener('focusin', onListFocus);
    panel?.removeEventListener('mouseover', onMouseOver);
    panel?.removeEventListener('mouseleave', hidePreview);
    previewImg()?.removeEventListener('error', hideForPreviewError);
    io?.disconnect();
    io = null;
    hidePreview();
    probeQueue = [];
    generation++;
    unsubscribe?.();
    unsubscribe = null;
  }

  return { mount, update, destroy, hidePreview, metaCache };
}
