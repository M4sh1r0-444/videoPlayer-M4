/**
 * 播放器（P2）：视频生命周期、续播、进度持久化、转封装浮条、控制条与快捷键。
 * 只通过 store.dispatch 改应用状态；不直接写 window.api。
 */

import { fmtTime, shouldResume } from '../core/index.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function createPlayer() {
  let root = null;
  let ctx = null;
  let video = null;
  let listeners = [];
  let loadedToken = -1;
  let loadedCourseKey = null;
  let remuxToken = 0;
  let suppressError = false;
  let lastCommitAt = 0;
  let seeking = false;

  const $ = (id) => document.getElementById(id);

  function on(target, type, handler, options) {
    target.addEventListener(type, handler, options);
    listeners.push([target, type, handler, options]);
  }

  function current(state = ctx.store.get()) {
    const course = state.library.course;
    const index = state.playback.index;
    return course && index >= 0 ? { course, ep: course.episodes[index] } : null;
  }

  function showOverlay(text) {
    $('ovText').textContent = text;
    $('videoOverlay').classList.remove('hidden');
  }

  function hideOverlay() {
    $('videoOverlay').classList.add('hidden');
  }

  function showRemuxBar(ep, progress) {
    $('rbName').textContent = ep.filename;
    $('rbProg').value = Math.round((progress || 0) * 100);
    $('remuxBar').classList.remove('hidden');
  }

  function hideRemuxBar() {
    $('remuxBar').classList.add('hidden');
  }

  function updateNowPlaying(state, course, ep) {
    $('npTitle').textContent = ep.title;
    $('npSub').textContent = `${course.name} · 第 ${state.playback.index + 1} 集 / 共 ${course.episodes.length} 集`;
  }

  function setPlayLabel(paused) {
    const button = $('btnPlay');
    const label = paused ? '播放' : '暂停';
    button.classList.toggle('is-playing', !paused);
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.getAttribute('aria-pressed') !== (paused ? 'false' : 'true')) {
      button.setAttribute('aria-pressed', paused ? 'false' : 'true');
    }
  }

  function setMuteLabel() {
    const button = $('btnMute');
    const muted = video.muted || video.volume === 0;
    const label = muted ? '取消静音' : '静音';
    button.classList.toggle('is-muted', muted);
    if (button.getAttribute('aria-label') !== label) button.setAttribute('aria-label', label);
    if (button.getAttribute('aria-pressed') !== (muted ? 'true' : 'false')) {
      button.setAttribute('aria-pressed', muted ? 'true' : 'false');
    }
  }

  function syncControls() {
    if (!video) return;
    setPlayLabel(video.paused);
    $('volBar').value = Math.round(video.volume * 100);
    setMuteLabel();
    $('speedSel').value = String(video.playbackRate);
    $('seekBar').value = video.duration ? Math.round((video.currentTime / video.duration) * 1000) : 0;
    $('timeLabel').textContent = '00:00 / 00:00';
  }

  function loadVideo(filePath, autoplay) {
    const state = ctx.store.get();
    const url = ctx.api.mediaUrl(filePath);
    if (!url.ok) {
      showOverlay('播放失败：无法生成媒体地址');
      return;
    }
    video.src = url.data;
    video.load();
    video.playbackRate = Number(state.playback.rate) || 1;
    video.volume = Math.min(1, Math.max(0, Number(state.playback.volume)));
    if (autoplay) video.play().catch(() => {});
    syncControls();
  }

  function commitProgress() {
    const state = ctx.store.get();
    const pair = current(state);
    if (!pair) return;
    if (!Number.isFinite(video.currentTime) || !Number.isFinite(video.duration) || video.duration <= 0) return;
    ctx.store.dispatch('recordProgress', {
      path: pair.ep.path,
      position: video.currentTime,
      duration: video.duration,
    });
    lastCommitAt = Date.now();
  }

  function flushProgress() {
    commitProgress();
  }

  async function playViaRemux(ep, autoplay, token) {
    hideRemuxBar();
    showRemuxBar(ep, 0);
    let st = null;
    const started = await ctx.api.remuxStart(ep.path);
    if (started.ok) st = started.data;
    while (st && st.status === 'running') {
      if (token !== remuxToken) return;
      showRemuxBar(ep, st.progress);
      await sleep(400);
      if (token !== remuxToken) return;
      const next = await ctx.api.remuxStatus(ep.path);
      st = next.ok ? next.data : null;
      if (!st) break;
    }
    if (token !== remuxToken) return;
    hideRemuxBar();
    if (st && st.status === 'ready' && st.file) {
      ctx.store.dispatch('setRemux', { path: ep.path, status: 'ready', progress: 1 });
      ctx.store.dispatch('markRemuxReady', ep.path);
      loadVideo(st.file, autoplay);
      return;
    }
    const msg = st && st.status === 'no-ffmpeg'
      ? `「${ep.filename}」需 ffmpeg 转封装后才能内播（未检测到 ffmpeg，见设置页说明）`
      : `「${ep.filename}」不是浏览器内核直接支持的格式（如 MKV/RMVB/FLV），请用系统播放器打开`;
    ctx.store.dispatch('setRemux', { path: ep.path, status: st ? st.status : 'failed', progress: 0 });
    showOverlay(msg);
  }

  function loadEpisode(state) {
    const pair = current(state);
    if (!pair) return;
    const { course, ep } = pair;
    loadedToken = state.playback.loadToken;
    loadedCourseKey = course.key;
    remuxToken++;
    const token = remuxToken;
    suppressError = false;
    lastCommitAt = 0;
    hideOverlay();
    hideRemuxBar();
    updateNowPlaying(state, course, ep);
    if (ep.playable) loadVideo(ep.path, state.playback.autoplay);
    else playViaRemux(ep, state.playback.autoplay, token);
  }

  function onLoadedMetadata() {
    const state = ctx.store.get();
    const pair = current(state);
    if (pair) {
      const record = state.library.videos[pair.ep.path];
      if (shouldResume(record, video.duration)) video.currentTime = record.position;
    }
    syncControls();
    $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  }

  function onTimeUpdate() {
    if (!video.duration) return;
    if (!seeking) $('seekBar').value = Math.round((video.currentTime / video.duration) * 1000);
    $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
    const now = Date.now();
    if (now - lastCommitAt > 3000 && !video.paused) commitProgress();
  }

  function onEnded() {
    commitProgress();
    const state = ctx.store.get();
    if (state.ui.autoNext && state.library.course && state.playback.index < state.library.course.episodes.length - 1) {
      ctx.store.dispatch('playEpisode', state.playback.index + 1);
    }
  }

  function onVideoError() {
    const state = ctx.store.get();
    const pair = current(state);
    if (!pair || suppressError) return;
    suppressError = true;
    showOverlay(pair.ep.playable
      ? `播放失败：${pair.ep.filename}\n（可能是编码不受支持）`
      : `「${pair.ep.filename}」不是浏览器内核直接支持的格式（如 MKV/RMVB/FLV），请用系统播放器打开`);
  }

  function togglePlay() {
    if (video.paused) video.play().catch(() => {});
    else video.pause();
  }

  function toggleMute() {
    video.muted = !video.muted;
    setMuteLabel();
  }

  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen();
    else root.requestFullscreen().catch(() => {});
  }

  function handleKey(event) {
    const state = ctx.store.get();
    const hasCourse = !!(state.library.course && state.playback.index >= 0);
    switch (event.key) {
      case ' ':
        event.preventDefault();
        if (hasCourse) togglePlay();
        return true;
      case 'ArrowLeft':
        if (hasCourse) video.currentTime -= event.shiftKey ? 30 : 5;
        return true;
      case 'ArrowRight':
        if (hasCourse) video.currentTime += event.shiftKey ? 30 : 5;
        return true;
      case 'ArrowUp':
        event.preventDefault();
        video.volume = Math.min(1, Math.max(0, video.volume + 0.05));
        $('volBar').value = video.volume * 100;
        return true;
      case 'ArrowDown':
        event.preventDefault();
        video.volume = Math.min(1, Math.max(0, video.volume - 0.05));
        $('volBar').value = video.volume * 100;
        return true;
      case 'f':
      case 'F':
        toggleFullscreen();
        return true;
      case 'm':
      case 'M':
        toggleMute();
        return true;
      case 'n':
      case 'N':
        ctx.store.dispatch('playNext');
        return true;
      case 'p':
      case 'P':
        ctx.store.dispatch('playPrev');
        return true;
      default:
        if (/^[0-9]$/.test(event.key) && hasCourse && video.duration) {
          video.currentTime = (parseInt(event.key, 10) / 10) * video.duration;
          return true;
        }
        return false;
    }
  }

  function mount(container, context) {
    root = container;
    ctx = context;
    video = $('video');

    on(video, 'loadedmetadata', onLoadedMetadata);
    on(video, 'timeupdate', onTimeUpdate);
    on(video, 'ended', onEnded);
    on(video, 'play', () => {
      setPlayLabel(false);
    });
    on(video, 'pause', () => {
      setPlayLabel(true);
      commitProgress();
    });
    on(video, 'error', onVideoError);
    on(video, 'dblclick', toggleFullscreen);
    on(video, 'click', togglePlay);

    on($('btnPlay'), 'click', togglePlay);
    on($('btnPrev'), 'click', () => ctx.store.dispatch('playPrev'));
    on($('btnNext'), 'click', () => ctx.store.dispatch('playNext'));
    on($('seekBar'), 'input', () => { seeking = true; });
    on($('seekBar'), 'change', () => {
      if (video.duration) video.currentTime = ($('seekBar').value / 1000) * video.duration;
      seeking = false;
    });
    on($('volBar'), 'input', () => {
      video.volume = $('volBar').value / 100;
      video.muted = false;
      setMuteLabel();
      ctx.store.dispatch('setVolume', video.volume);
    });
    on($('btnMute'), 'click', toggleMute);
    on($('speedSel'), 'change', () => {
      video.playbackRate = parseFloat($('speedSel').value);
      ctx.store.dispatch('setRate', video.playbackRate);
    });
    on($('btnFull'), 'click', toggleFullscreen);
    on($('ovOpenSys'), 'click', () => {
      const pair = current();
      if (pair) ctx.api.openPath(pair.ep.path);
    });
    on($('ovReveal'), 'click', () => {
      const pair = current();
      if (pair) ctx.api.reveal(pair.ep.path);
    });
    syncControls();
    return { update, destroy, flushProgress, handleKey, getVideo: () => video };
  }

  function update(state) {
    const pair = current(state);
    if (!pair) return;
    if (state.playback.loadToken !== loadedToken || pair.course.key !== loadedCourseKey) {
      loadEpisode(state);
    }
  }

  function destroy() {
    for (const [target, type, handler, options] of listeners) target.removeEventListener(type, handler, options);
    listeners = [];
    remuxToken++;
    hideRemuxBar();
    hidePreviewSafe();
    video?.pause();
  }

  function hidePreviewSafe() {
    document.getElementById('hoverPreview')?.classList.add('hidden');
  }

  return { mount, update, destroy, flushProgress, handleKey, getVideo: () => video };
}
