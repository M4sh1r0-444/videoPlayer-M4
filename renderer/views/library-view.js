/**
 * 主视图（P2）：组合侧栏 + 分集列表 + 播放器，并负责空状态/分集过滤。
 */

import { createSidebar } from '../components/sidebar.js';
import { createEpisodeList } from '../components/episode-list.js';
import { createPlayer } from '../components/player.js';

export function createLibraryView() {
  let root = null;
  let ctx = null;
  let sidebar = null;
  let list = null;
  let player = null;
  let searchBox = null;
  let lastCourse = null;

  function onEmptyOpenDir() {
    ctx.store.dispatch('addRootsFromPicker');
  }

  function onEmptyImport() {
    ctx.store.dispatch('beginImportFromPicker');
  }

  function onFilterInput() {
    ctx.store.dispatch('setFilter', searchBox.value.trim());
  }

  function mount(container, context) {
    root = container;
    ctx = context;
    sidebar = createSidebar();
    list = createEpisodeList();
    player = createPlayer();
    sidebar.mount(document.getElementById('subjectTree'), context);
    list.mount(document.getElementById('episodeList'), context);
    player.mount(document.getElementById('playerWrap'), context);

    searchBox = document.getElementById('searchBox');
    searchBox.addEventListener('input', onFilterInput);
    document.getElementById('emptyOpenDir').addEventListener('click', onEmptyOpenDir);
    document.getElementById('emptyImport').addEventListener('click', onEmptyImport);
    return { update, destroy, get player() { return player; }, get list() { return list; } };
  }

  function update(state) {
    sidebar.update(state);
    list.update(state);
    player.update(state);

    const course = state.library.course;
    const hasEpisodes = !!(course && course.episodes.length);
    const emptyVisible = course
      ? !hasEpisodes
      : !state.library.subjects.some((subject) => subject.courses.length > 0);
    document.getElementById('playerWrap').classList.toggle('hidden', !hasEpisodes);
    document.getElementById('emptyState').classList.toggle('hidden', !emptyVisible);

    if (course !== lastCourse) {
      if (searchBox) searchBox.value = state.library.filterText;
      lastCourse = course;
    }
  }

  function destroy() {
    searchBox?.removeEventListener('input', onFilterInput);
    document.getElementById('emptyOpenDir')?.removeEventListener('click', onEmptyOpenDir);
    document.getElementById('emptyImport')?.removeEventListener('click', onEmptyImport);
    sidebar?.destroy();
    list?.destroy();
    player?.destroy();
  }

  return { mount, update, destroy, get player() { return player; }, get list() { return list; } };
}
