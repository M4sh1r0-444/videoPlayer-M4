/**
 * 所有状态变更的唯一入口（P2）。
 *
 * 依赖方向：actions → api / persist / core / store（由组合根注入）。
 * 组件只通过 `store.dispatch('actionName', ...)` 调用这里，不直接写 store / IPC。
 */

import {
  baseName,
  isCompleted,
  isDocFile,
  isVideoFile,
  makeEpisode,
  matchDocs,
  sortEpisodes,
  watchedDelta,
  localDateKey,
  dirNameOf,
} from '../core/index.js';
import { findCourseLocation, settingsOf } from './selectors.js';
import { createAiActions } from './ai-actions.js';

/** 停靠区页签（notes 仅占位，P4 再实现） */
export const DOCK_TABS = Object.freeze(['docs', 'ai', 'notes']);

/** UI 偏好只写 localStorage（不新增 learn.json 字段） */
const UI_PREF_DOCK_TAB = 'vds.dockTab';
const UI_PREF_NAV_COLLAPSED = 'vds.navCollapsed';

function readUiPref(key, fallback) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

function writeUiPref(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    /* localStorage 仅作界面偏好 */
  }
}

/** 启动时读取 dock 页签 / 侧栏折叠态；供组合根覆盖 hydrateState 的默认值 */
export function readUiPrefs() {
  return {
    dockTab: DOCK_TABS.includes(readUiPref(UI_PREF_DOCK_TAB, 'ai')) ? readUiPref(UI_PREF_DOCK_TAB, 'ai') : 'ai',
    navCollapsed: readUiPref(UI_PREF_NAV_COLLAPSED, 'false') === 'true',
  };
}

/** 组装科目/课程树（纯函数，便于单测；不修改传入对象） */
export function buildSubjects(scanned, data) {
  const subjects = JSON.parse(JSON.stringify(Array.isArray(scanned) ? scanned : []));
  const findSubject = (name) => {
    let subject = subjects.find((x) => x.name === name);
    if (!subject) {
      subject = { name, courses: [] };
      subjects.push(subject);
    }
    return subject;
  };

  for (const cc of data.customCourses || []) {
    const subject = findSubject(cc.subject);
    const course = {
      key: 'custom:' + cc.id,
      name: cc.name,
      path: cc.sourceDir || '',
      custom: cc,
      episodes: sortEpisodes((cc.videos || []).map(makeEpisode)),
      docs: (cc.docs || []).map((d) => ({ path: d.path, name: baseName(d.path), episodeIndex: null })),
    };
    subject.courses.push(course);
  }

  const ignored = data.docsIgnored || {};
  const binds = data.docBinds || {};
  for (const subject of subjects) {
    for (const course of subject.courses) {
      if (ignored[course.path]) course.docs = (course.docs || []).filter((d) => !ignored[course.path].includes(d.path));
      const extra = (data.docsByCourse || {})[course.path];
      if (extra) {
        course.docs = course.docs || [];
        course.docs.push(...extra.map((p) => ({ path: p, name: baseName(p), episodeIndex: null })));
      }
      if (!course.key) course.key = course.path;
      matchDocs(course, binds);
    }
  }
  return subjects;
}

/* 课程树不可变替换：只克隆命中的科目/课程，保留其余引用 */
function replaceCourse(state, courseKey, updater) {
  const lib = state.library;
  let replaced = null;
  const subjects = lib.subjects.map((subject) => {
    let changed = false;
    const courses = subject.courses.map((course) => {
      if (course.key !== courseKey) return course;
      changed = true;
      replaced = updater(course);
      return replaced;
    });
    return changed ? { ...subject, courses } : subject;
  });
  if (!replaced) return state;
  const isCurrent = lib.course && lib.course.key === courseKey;
  const location = isCurrent ? findCourseLocation(subjects, courseKey) : null;
  return {
    ...state,
    library: {
      ...lib,
      subjects,
      subject: location ? location.subject : lib.subject,
      course: location ? location.course : lib.course,
    },
  };
}

function cloneCustomCourses(list) {
  return (list || []).map((cc) => ({
    ...cc,
    videos: (cc.videos || []).slice(),
    docs: (cc.docs || []).map((d) => ({ ...d })),
  }));
}

let importSeq = 0;

/**
 * @param {{
 *   store: ReturnType<import('./store.js').createStore>,
 *   api: ReturnType<import('./api.js').createApi>,
 *   persist: ReturnType<import('./persist.js').createPersist>,
 *   toast: { show: Function },
 *   beforeChange?: () => void,
 * }} deps
 */
export function createActions({ store, api, persist, toast, beforeChange }) {
  const say = (message) => {
    try {
      toast?.show?.(message);
    } catch {
      /* toast 不是业务状态 */
    }
  };
  let scanSeq = 0;

  function persistSettings() {
    persist.queue({ settings: settingsOf(store.get()) });
  }

  async function refreshRemuxBadges(course) {
    const targets = (course.episodes || []).filter((ep) => !ep.playable).map((ep) => ep.path);
    if (!targets.length) return;
    const result = await api.remuxCheck(targets);
    if (!result.ok) return;
    const ready = Array.isArray(result.data) ? result.data : [];
    const state = store.get();
    if (!state.library.course || state.library.course.key !== course.key) return;
    const map = {};
    for (const path of ready) map[path] = true;
    store.set((s) => ({
      ...s,
      library: { ...s.library, remuxReady: { ...s.library.remuxReady, ...map } },
    }));
  }

  /**
   * 重扫目录并重建树。
   * @param {{ keepSelection?: boolean }} [options]
   */
  async function refreshTree({ keepSelection = true } = {}) {
    const seq = ++scanSeq;
    const before = store.get();
    const result = await api.scanRoots(before.library.roots);
    if (seq !== scanSeq) return store.get().library.subjects;
    const scanned = result.ok && Array.isArray(result.data) ? result.data : [];
    if (!result.ok) say('扫描学习目录失败，已保留当前课程');
    const subjects = buildSubjects(scanned, {
      customCourses: before.library.customCourses,
      docsByCourse: before.library.docsByCourse,
      docsIgnored: before.library.docsIgnored,
      docBinds: before.library.docBinds,
    });
    const key = keepSelection && before.library.course ? before.library.course.key : null;
    const location = key ? findCourseLocation(subjects, key) : null;
    store.set((s) => ({
      ...s,
      library: {
        ...s.library,
        subjects,
        subject: location ? location.subject : null,
        course: location ? location.course : null,
      },
    }));
    return subjects;
  }

  async function selectCourse(subject, course, episodeIndex = -1, { autoplay = false } = {}) {
    if (!course) return;
    beforeChange?.();
    const state = store.get();
    const location = findCourseLocation(state.library.subjects, course.key) || { subject, course };
    const target = location.course;
    const index = Number.isInteger(episodeIndex) && episodeIndex >= 0 && episodeIndex < target.episodes.length
      ? episodeIndex
      : -1;
    const playback = {
      ...state.playback,
      index,
      autoplay: index >= 0 ? !!autoplay : false,
      lastPosition: null,
      suppressErrorOnce: false,
      remux: null,
      position: 0,
      duration: 0,
    };
    if (index >= 0) {
      playback.loadToken = state.playback.loadToken + 1;
      playback.lastEpisodePath = target.episodes[index].path;
    }
    store.set((s) => ({
      ...s,
      library: {
        ...s.library,
        subject: location.subject,
        course: target,
        remuxReady: {},
        filterText: '',
        lastCoursePath: target.key,
      },
      playback,
    }));
    persistSettings();
    refreshRemuxBadges(target);
  }

  function playEpisode(index, { autoplay = true } = {}) {
    const current = store.get();
    const course = current.library.course;
    if (!course || !Number.isInteger(index) || index < 0 || index >= course.episodes.length) return;
    beforeChange?.();
    const state = store.get();
    const targetCourse = state.library.course;
    const ep = targetCourse && targetCourse.episodes[index];
    if (!ep) return;
    store.set((s) => ({
      ...s,
      playback: {
        ...s.playback,
        index,
        loadToken: s.playback.loadToken + 1,
        autoplay: autoplay !== false,
        lastPosition: null,
        lastEpisodePath: ep.path,
        suppressErrorOnce: false,
        remux: null,
        position: 0,
        duration: 0,
      },
    }));
    persistSettings();
  }

  function recordProgress({ path, position, duration, at = Date.now() } = {}) {
    const p = Number(position);
    const d = Number(duration);
    if (!path || !Number.isFinite(p) || !Number.isFinite(d) || d <= 0) return;
    const state = store.get();
    const previous = state.library.videos[path] || {};
    const record = {
      ...previous,
      position: p,
      duration: d,
      lastPlayedAt: new Date(at).toISOString(),
    };
    if (!record.completed && isCompleted(p, d)) record.completed = true;

    const isCurrent = currentEpisodePath(state) === path;
    let daily = state.stats.daily;
    let lastPosition = state.playback.lastPosition;
    if (isCurrent && lastPosition != null) {
      const delta = watchedDelta(lastPosition, p);
      if (delta > 0) {
        const key = localDateKey(new Date(at));
        daily = { ...daily, [key]: (daily[key] || 0) + delta };
      }
      lastPosition = p;
    }

    const videos = { ...state.library.videos, [path]: record };
    store.set((s) => ({
      ...s,
      library: { ...s.library, videos },
      stats: { ...s.stats, daily },
      playback: {
        ...s.playback,
        position: p,
        duration: d,
        lastPosition: isCurrent ? lastPosition : s.playback.lastPosition,
      },
    }));
    persist.queue({ videos, stats: { daily } });
  }

  function currentEpisodePath(state) {
    const course = state.library.course;
    const i = state.playback.index;
    return course && i >= 0 && course.episodes[i] ? course.episodes[i].path : null;
  }

  function setEpisodeDuration(path, duration) {
    const d = Number(duration);
    if (!path || !Number.isFinite(d) || d <= 0) return;
    const state = store.get();
    const previous = state.library.videos[path] || {};
    if (Number(previous.duration) > 0) return;
    const videos = { ...state.library.videos, [path]: { ...previous, duration: d } };
    store.set((s) => ({ ...s, library: { ...s.library, videos } }));
    persist.queue({ videos });
  }

  function setRemux(remux) {
    store.set((s) => ({ ...s, playback: { ...s.playback, remux: remux ? { ...remux } : null } }));
  }

  function markRemuxReady(path) {
    if (!path) return;
    store.set((s) => ({
      ...s,
      library: { ...s.library, remuxReady: { ...s.library.remuxReady, [path]: true } },
    }));
  }

  function setRate(rate) {
    const value = Number(rate);
    if (!Number.isFinite(value) || value <= 0) return;
    store.set((s) => ({ ...s, playback: { ...s.playback, rate: value } }));
    persistSettings();
  }

  function setVolume(volume) {
    const value = Math.min(1, Math.max(0, Number(volume)));
    if (!Number.isFinite(value)) return;
    store.set((s) => ({ ...s, playback: { ...s.playback, volume: value } }));
    persistSettings();
  }

  function setAutoNext(on) {
    store.set((s) => ({ ...s, ui: { ...s.ui, autoNext: !!on } }));
    persistSettings();
  }

  function setTheme(theme) {
    const next = theme === 'light' ? 'light' : 'dark';
    store.set((s) => ({ ...s, ui: { ...s.ui, theme: next } }));
    try {
      localStorage.setItem('theme', next);
    } catch {
      /* localStorage 只是首帧缓存 */
    }
    persistSettings();
  }

  function setPanelWidths(widths) {
    const state = store.get();
    const next = { ...state.ui.panelWidths };
    for (const key of ['sidebar', 'episodes', 'ai']) {
      const value = Math.round(Number(widths && widths[key]));
      if (Number.isFinite(value) && value > 0) next[key] = value;
    }
    store.set((s) => ({ ...s, ui: { ...s.ui, panelWidths: next } }));
    persistSettings();
  }

  function setFilter(filterText) {
    store.set((s) => ({ ...s, library: { ...s.library, filterText: String(filterText ?? '') } }));
  }

  function setView(view) {
    if (view !== 'library' && view !== 'dashboard') return;
    store.set((s) => ({ ...s, ui: { ...s.ui, view } }));
  }

  function toggleView() {
    setView(store.get().ui.view === 'dashboard' ? 'library' : 'dashboard');
  }

  function setModal(modal, payload = null) {
    store.set((s) => ({
      ...s,
      ui: {
        ...s.ui,
        modal: modal || null,
        importCtx: modal === 'import' ? (payload || s.ui.importCtx) : null,
        docsOpen: false,
        helpOpen: false,
      },
      // 每次打开设置页重置「测试连接」结果（与旧 ai.js 的 renderAiSettings 一致）
      ai: modal === 'settings' ? { ...s.ai, testing: false, testMessage: '', testOk: null } : s.ai,
    }));
  }

  function openImport(ctx) {
    if (!ctx) return;
    setModal('import', ctx);
  }

  /* ---------------- 停靠区 / 侧栏 / 帮助 ---------------- */

  function setDockOpen(open, tab) {
    // notes 仅结构占位，不接受打开/切换（P4 实现笔记本体）
    const nextTab = DOCK_TABS.includes(tab) && tab !== 'notes' ? tab : null;
    store.set((s) => ({
      ...s,
      ui: {
        ...s.ui,
        dockOpen: !!open,
        dockTab: nextTab || s.ui.dockTab,
        helpOpen: false,
      },
    }));
    if (nextTab) writeUiPref(UI_PREF_DOCK_TAB, nextTab);
  }

  function setDockTab(tab) {
    if (tab === 'notes' || !DOCK_TABS.includes(tab)) return;
    store.set((s) => ({ ...s, ui: { ...s.ui, dockTab: tab, dockOpen: true } }));
    writeUiPref(UI_PREF_DOCK_TAB, tab);
  }

  function toggleDock(tab) {
    const state = store.get();
    if (state.ui.dockOpen && (!tab || state.ui.dockTab === tab)) {
      setDockOpen(false);
      return;
    }
    setDockOpen(true, tab);
  }

  function setNavCollapsed(collapsed) {
    const value = !!collapsed;
    store.set((s) => ({ ...s, ui: { ...s.ui, navCollapsed: value, navDrawerOpen: false } }));
    writeUiPref(UI_PREF_NAV_COLLAPSED, value);
  }

  function toggleNavCollapsed() {
    setNavCollapsed(!store.get().ui.navCollapsed);
  }

  function setNavDrawerOpen(open) {
    store.set((s) => ({ ...s, ui: { ...s.ui, navDrawerOpen: !!open } }));
  }

  function toggleNavDrawer() {
    setNavDrawerOpen(!store.get().ui.navDrawerOpen);
  }

  function setHelpOpen(open) {
    store.set((s) => ({ ...s, ui: { ...s.ui, helpOpen: !!open, modal: null, importCtx: null } }));
  }

  /* 旧讲义浮层 API（?legacy=1 与新路径共用 actions 时保留语义） */
  function setDocsOpen(open) {
    store.set((s) => ({ ...s, ui: { ...s.ui, docsOpen: !!open, modal: null, importCtx: null } }));
  }

  function toggleDocsMenu() {
    setDocsOpen(!store.get().ui.docsOpen);
  }

  async function beginImportFromPicker() {
    const result = await api.pickFiles();
    if (!result.ok || !Array.isArray(result.data) || !result.data.length) return;
    const paths = result.data;
    const videos = paths.filter((p) => isVideoFile(p));
    const docs = paths.filter((p) => isDocFile(p));
    if (videos.length) openImport({ type: 'videos', files: videos, extraDocs: docs });
    else if (docs.length) openImport({ type: 'docs', files: docs });
  }

  async function addRootsFromPicker() {
    const result = await api.pickFolders();
    if (!result.ok || !Array.isArray(result.data) || !result.data.length) return;
    const state = store.get();
    const added = [];
    for (const p of result.data) {
      if (!state.library.roots.includes(p)) added.push(p);
    }
    if (!added.length) return;
    const roots = [...state.library.roots, ...added];
    store.set((s) => ({ ...s, library: { ...s.library, roots } }));
    persist.queue({ roots });
    await refreshTree();
    // 与旧行为一致：自动选中新目录的第一个课程
    const rootName = added[0].split(/[\\/]/).filter(Boolean).pop();
    const stateAfter = store.get();
    const subject = stateAfter.library.subjects.find((x) => x.name === rootName) || stateAfter.library.subjects[0];
    if (subject && subject.courses.length) selectCourse(subject, subject.courses[0]);
  }

  async function removeRoot(path) {
    const state = store.get();
    const roots = state.library.roots.filter((x) => x !== path);
    store.set((s) => ({ ...s, library: { ...s.library, roots } }));
    persist.queue({ roots });
    await refreshTree();
  }

  function refreshDocMatch(course) {
    const state = store.get();
    const target = course || state.library.course;
    if (!target) return;
    const nextState = replaceCourse(state, target.key, (c) => {
      const docs = (c.docs || []).map((d) => ({ ...d }));
      const next = { ...c, docs };
      matchDocs(next, state.library.docBinds);
      return next;
    });
    if (nextState === state) return;
    store.set(nextState);
    say(`已重新匹配「${target.name}」的讲义`);
  }

  function bindDoc(doc) {
    const state = store.get();
    const course = state.library.course;
    const index = state.playback.index;
    if (!course || !doc || index < 0) return;
    const docBinds = { ...state.library.docBinds, [doc.path]: index };
    const nextState = replaceCourse(state, course.key, (c) => ({
      ...c,
      docs: (c.docs || []).map((d) => (d.path === doc.path ? { ...d, episodeIndex: index } : d)),
    }));
    store.set({
      ...nextState,
      library: { ...nextState.library, docBinds },
    });
    persist.queue({ docBinds });
    say(`已关联「${doc.name}」→ 第 ${index + 1} 集`);
  }

  function removeDoc(doc) {
    const state = store.get();
    const course = state.library.course;
    if (!course || !doc) return;
    const docsByCourse = { ...state.library.docsByCourse };
    const docsIgnored = { ...state.library.docsIgnored };
    const docBinds = { ...state.library.docBinds };
    let customCourses = state.library.customCourses;

    const ccIndex = state.library.customCourses.findIndex((cc) => 'custom:' + cc.id === course.key);
    if (ccIndex >= 0) {
      customCourses = cloneCustomCourses(state.library.customCourses);
      customCourses[ccIndex].docs = customCourses[ccIndex].docs.filter((x) => x.path !== doc.path);
    } else if ((docsByCourse[course.path] || []).includes(doc.path)) {
      docsByCourse[course.path] = docsByCourse[course.path].filter((p) => p !== doc.path);
      if (!docsByCourse[course.path].length) delete docsByCourse[course.path];
    } else {
      docsIgnored[course.path] = Array.from(new Set([...(docsIgnored[course.path] || []), doc.path]));
    }
    delete docBinds[doc.path];

    const nextState = replaceCourse(state, course.key, (c) => ({
      ...c,
      docs: (c.docs || []).filter((d) => d.path !== doc.path),
    }));
    store.set({
      ...nextState,
      library: {
        ...nextState.library,
        customCourses,
        docsByCourse,
        docsIgnored,
        docBinds,
      },
    });
    persist.queue({ customCourses, docsByCourse, docsIgnored, docBinds });
    say('已移除该讲义');
  }

  function nextCustomId() {
    importSeq += 1;
    return 'c' + Date.now().toString(36) + importSeq.toString(36);
  }

  function sourceDirOf(filePath) {
    // 渲染层不能依赖 Node：按路径里实际的分隔符推断（Windows \ / POSIX /），不新增 IPC
    return dirNameOf(filePath);
  }

  /**
   * 导入弹窗确认后的数据变更。
   * @param {{type:'videos'|'folder'|'docs', files?:string[], dirs?:string[], extraDocs?:string[]}} ctx
   * @param {{subject:string, courseKey:string, courseName?:string}} form
   */
  async function applyImport(ctx, form) {
    const state = store.get();
    const subjectName = String(form.subject || '').trim();
    const courseKey = form.courseKey || '__new__';
    const courseName = String(form.courseName || '').trim();
    const customCourses = cloneCustomCourses(state.library.customCourses);
    const docsByCourse = { ...state.library.docsByCourse };
    let targetKey = null;

    if (ctx.type === 'videos') {
      const extraDocs = ctx.extraDocs || [];
      if (courseKey === '__new__') {
        if (!subjectName || !courseName) return false;
        const cc = {
          id: nextCustomId(),
          subject: subjectName,
          name: courseName,
          sourceDir: sourceDirOf(ctx.files[0]),
          videos: ctx.files.slice(),
          docs: extraDocs.map((p) => ({ path: p })),
        };
        customCourses.push(cc);
        targetKey = 'custom:' + cc.id;
      } else {
        const cc = customCourses.find((c) => 'custom:' + c.id === courseKey);
        if (!cc) return false;
        const set = new Set(cc.videos);
        for (const file of ctx.files) if (!set.has(file)) cc.videos.push(file);
        const docSet = new Set(cc.docs.map((d) => d.path));
        for (const file of extraDocs) if (!docSet.has(file)) cc.docs.push({ path: file });
        targetKey = courseKey;
      }
    } else if (ctx.type === 'folder') {
      for (const dir of ctx.dirs || []) {
        const scanned = await api.scanCourse(dir);
        if (!scanned.ok || !scanned.data) continue;
        const data = scanned.data;
        const cc = {
          id: nextCustomId(),
          subject: subjectName,
          name: courseName || data.name,
          sourceDir: dir,
          videos: (data.episodes || []).map((e) => e.path),
          docs: (data.docs || []).map((d) => ({ path: d.path })),
        };
        customCourses.push(cc);
        targetKey = 'custom:' + cc.id;
      }
      if (!targetKey) return false;
    } else if (ctx.type === 'docs') {
      const hasCourses = state.library.subjects.some((s) => s.courses.length);
      if (!courseKey || courseKey === '__new__' || !hasCourses) {
        if (!subjectName) return false;
        const cc = {
          id: nextCustomId(),
          subject: subjectName,
          name: courseName || '讲义资料',
          sourceDir: '',
          videos: [],
          docs: ctx.files.map((p) => ({ path: p })),
        };
        customCourses.push(cc);
        targetKey = 'custom:' + cc.id;
      } else {
        const cc = customCourses.find((c) => 'custom:' + c.id === courseKey);
        if (cc) {
          const set = new Set(cc.docs.map((d) => d.path));
          for (const file of ctx.files) if (!set.has(file)) cc.docs.push({ path: file });
        } else {
          const location = findCourseLocation(state.library.subjects, courseKey);
          if (!location) return false;
          const path = location.course.path;
          const list = Array.from(new Set([...(docsByCourse[path] || []), ...ctx.files]));
          docsByCourse[path] = list;
        }
        targetKey = courseKey;
      }
    } else return false;

    store.set((s) => ({
      ...s,
      ui: { ...s.ui, modal: null, importCtx: null },
      library: { ...s.library, customCourses, docsByCourse },
    }));
    persist.queue({ customCourses, docsByCourse });
    await refreshTree();
    const location = findCourseLocation(store.get().library.subjects, targetKey);
    if (location) selectCourse(location.subject, location.course);
    return true;
  }

  async function bootstrap() {
    await refreshTree({ keepSelection: false });
    const state = store.get();
    const location = findCourseLocation(state.library.subjects, state.library.lastCoursePath);
    if (!location) return;
    const index = location.course.episodes.findIndex((ep) => ep.path === state.playback.lastEpisodePath);
    selectCourse(location.subject, location.course, index, { autoplay: false });
  }

  const aiActions = createAiActions({
    store,
    api,
    toast,
    openSettings: () => setModal('settings'),
  });

  const actions = {
    ...aiActions,
    bootstrap,
    refreshTree,
    selectCourse,
    playEpisode,
    playNext: () => {
      const s = store.get();
      if (s.library.course && s.playback.index < s.library.course.episodes.length - 1) playEpisode(s.playback.index + 1);
    },
    playPrev: () => {
      const s = store.get();
      if (s.playback.index > 0) playEpisode(s.playback.index - 1);
    },
    recordProgress,
    setEpisodeDuration,
    setRemux,
    markRemuxReady,
    setRate,
    setVolume,
    setAutoNext,
    setTheme,
    setPanelWidths,
    setFilter,
    setView,
    toggleView,
    setModal,
    openImport,
    setDockOpen,
    setDockTab,
    toggleDock,
    setNavCollapsed,
    toggleNavCollapsed,
    setNavDrawerOpen,
    toggleNavDrawer,
    setHelpOpen,
    setDocsOpen,
    toggleDocsMenu,
    beginImportFromPicker,
    addRootsFromPicker,
    removeRoot,
    refreshDocMatch,
    bindDoc,
    removeDoc,
    applyImport,
  };

  store.dispatch.actions = actions;
  return actions;
}
