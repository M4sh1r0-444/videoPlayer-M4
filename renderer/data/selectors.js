/**
 * 派生数据（只读、记忆化）。不依赖 DOM。
 *
 * 调用方传整个 state，而不是悄悄读取某个全局 store，便于单测和复用。
 */

import { localDateKey, percentOf } from '../core/index.js';

const courseStatsCache = new WeakMap(); // course -> { videos, value }
const subjectStatsCache = new WeakMap(); // subject -> { videos, value }
let filteredCache = null; // { course, filter, value }
let weekCache = null; // { daily, day, value }

/** 当前分集（无课程/未选中时 null） */
export function currentEpisode(state) {
  const { course, index: _unused } = state.library;
  const i = state.playback.index;
  return course && i >= 0 ? course.episodes[i] || null : null;
}

/** 当前分集在课程里的下标（无则 -1） */
export function currentIndex(state) {
  return state.library.course ? state.playback.index : -1;
}

/** 课程完成度：{ done, total }；按 videos 引用做一档记忆化 */
export function courseStats(state, course = state.library.course) {
  if (!course) return { done: 0, total: 0 };
  const videos = state.library.videos;
  const hit = courseStatsCache.get(course);
  if (hit && hit.videos === videos) return hit.value;
  let done = 0;
  for (const ep of course.episodes || []) {
    if (videos[ep.path]?.completed) done++;
  }
  const value = { done, total: (course.episodes || []).length };
  courseStatsCache.set(course, { videos, value });
  return value;
}

/** 科目完成度（该科目所有课程相加） */
export function subjectStats(state, subject) {
  const videos = state.library.videos;
  const hit = subjectStatsCache.get(subject);
  if (hit && hit.videos === videos) return hit.value;
  let done = 0;
  let total = 0;
  for (const course of subject.courses || []) {
    const st = courseStats(state, course);
    done += st.done;
    total += st.total;
  }
  const value = { done, total };
  subjectStatsCache.set(subject, { videos, value });
  return value;
}

/** 整个库的完成度（看板/诊断用） */
export function libraryStats(state) {
  let done = 0;
  let total = 0;
  for (const subject of state.library.subjects) {
    const st = subjectStats(state, subject);
    done += st.done;
    total += st.total;
  }
  return { done, total };
}

/** 过滤后的分集（保持原始下标，行 key 仍用路径） */
export function filteredEpisodes(state) {
  const course = state.library.course;
  const filter = state.library.filterText.trim().toLowerCase();
  if (!course) return [];
  if (filteredCache && filteredCache.course === course && filteredCache.filter === filter) return filteredCache.value;
  const out = [];
  for (let index = 0; index < course.episodes.length; index++) {
    const ep = course.episodes[index];
    if (filter && !ep.title.toLowerCase().includes(filter) && !ep.filename.toLowerCase().includes(filter)) continue;
    out.push({ ep, index });
  }
  filteredCache = { course, filter, value: out };
  return out;
}

/** 某个分集对应的讲义（取第一份匹配） */
export function docForEpisode(course, index) {
  return (course && course.docs ? course.docs.find((d) => d.episodeIndex === index) : null) || null;
}

/** 按 key 找课程；找不到返回 null */
export function findCourseByKey(subjects, key) {
  if (!key) return null;
  for (const subject of subjects || []) {
    for (const course of subject.courses || []) {
      if (course.key === key) return course;
    }
  }
  return null;
}

/** 按 key 找 { subject, course } */
export function findCourseLocation(subjects, key) {
  if (!key) return null;
  for (const subject of subjects || []) {
    for (const course of subject.courses || []) {
      if (course.key === key) return { subject, course };
    }
  }
  return null;
}

function weekValue(state, now) {
  const daily = state.stats.daily || {};
  let weekSec = 0;
  let activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const v = daily[localDateKey(new Date(now.getTime() - i * 86400000))] || 0;
    weekSec += v;
    if (v > 0) activeDays++;
  }
  const weekAgo = now.getTime() - 7 * 86400000;
  let doneWeek = 0;
  for (const key of Object.keys(state.library.videos)) {
    const v = state.library.videos[key];
    if (v.completed && v.lastPlayedAt && Date.parse(v.lastPlayedAt) >= weekAgo) doneWeek++;
  }
  return {
    weekSec,
    activeDays,
    doneWeek,
    todaySec: daily[localDateKey(now)] || 0,
  };
}

/** 本周学习统计；按「日键 + daily 引用」记忆化 */
export function weekStats(state, now = new Date()) {
  const daily = state.stats.daily || {};
  const day = localDateKey(now);
  if (weekCache && weekCache.daily === daily && weekCache.day === day) return weekCache.value;
  const value = weekValue(state, now);
  weekCache = { daily, day, value };
  return value;
}

/** 继续学习卡片的数据（与 v0.4.4 判定一致） */
export function continueItem(state) {
  const { lastCoursePath, lastEpisodePath } = {
    lastCoursePath: state.library.lastCoursePath,
    lastEpisodePath: state.playback.lastEpisodePath,
  };
  const location = findCourseLocation(state.library.subjects, lastCoursePath);
  if (!location) return null;
  const { subject, course } = location;
  const index = course.episodes.findIndex((e) => e.path === lastEpisodePath);
  if (index < 0) return null;
  const ep = course.episodes[index];
  const record = state.library.videos[ep.path];
  if (!record || (record.position || 0) <= 10 || !(record.duration > 0) || record.completed) return null;
  return {
    subject,
    course,
    ep,
    index,
    record,
    percent: percentOf(record.position, record.duration),
  };
}

/** learn.json 的 settings 部分（保持 v0.4.4 字段与含义） */
export function settingsOf(state) {
  const { library, playback, ui } = state;
  return {
    rate: playback.rate,
    volume: playback.volume,
    autoNext: ui.autoNext,
    lastCoursePath: library.lastCoursePath,
    lastEpisodePath: playback.lastEpisodePath,
    theme: ui.theme,
    panelWidths: { ...ui.panelWidths },
  };
}

/** 渲染层状态 → 与 learn.json 完全一致的扁平对象（兼容 ai.js / 冒烟诊断） */
export function learnStore(state) {
  return {
    roots: state.library.roots,
    customCourses: state.library.customCourses,
    docsByCourse: state.library.docsByCourse,
    docsIgnored: state.library.docsIgnored,
    docBinds: state.library.docBinds,
    videos: state.library.videos,
    stats: { daily: state.stats.daily },
    settings: settingsOf(state),
    ai: state.ai.config,
  };
}
