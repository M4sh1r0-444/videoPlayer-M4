/* 学习播放器 渲染层 */

const $ = (id) => document.getElementById(id);

/* ---------- 主题（白天/夜间） ---------- */

// localStorage 做首帧缓存（脚本同步执行、早于首次绘制，避免等 IPC 时闪暗色）；
// learn.json 的 settings.theme 是持久真相，boot 时以此校正
function applyTheme(theme) {
  document.body.classList.toggle('light', theme === 'light');
  $('btnTheme').textContent = theme === 'light' ? '夜间' : '白天';
}
applyTheme(localStorage.getItem('theme') || 'dark');

/* ---------- 共享纯函数（renderer/core，由 lib-boot.js 注入） ---------- */

// 保持全局词法绑定：ai.js 仍可直接使用 fmtTime 等名字，行为与拆分前一致。
let sortEpisodes, makeEpisode;
let fmtTime, fmtDur, fmtBytes, localDateKey;
let matchDocs, progressState, isCompleted, shouldResume, watchedDelta;
let searchLibrary, isVideoFile, isDocFile;

// 分集行右侧文本：时长 + 完成度
function epRowPctText(p, duration) {
  const stateName = progressState(p);
  const dur = duration ?? p?.duration;
  const durTxt = dur ? fmtTime(dur) : '';
  const pct = stateName === 'done' ? '100%' : stateName === 'partial' ? Math.round((p.position / p.duration) * 100) + '%' : '';
  return (durTxt ? durTxt + ' ' : '') + pct;
}

/* ---------- 讲义 ↔ 分集 匹配：实现见 renderer/core/docmatch.js（matchDocs 由 lib-boot 注入） ---------- */

/* ---------- 状态 ---------- */

const state = {
  store: null,          // learn.json
  subjects: [],         // 合并后的树
  subject: null,
  course: null,         // 当前课程
  index: -1,            // 当前分集下标
  filterText: '',
  seeking: false,
  lastPersist: 0,
  lastPos: null,        // 上次持久化时的播放位置（学习时长统计用）
  remuxReady: new Set(), // 已有转封装缓存的分集路径（行上显示 ⚡）
  suppressErrorOnce: false,
};

const video = $('video');

/* ---------- 树构建 ---------- */

async function rebuildTree() {
  let scanned = [];
  try { scanned = await window.api.scanRoots(state.store.roots); } catch (e) { console.error('扫描失败', e); }
  const subjects = JSON.parse(JSON.stringify(scanned));

  const findSubject = (name) => {
    let s = subjects.find((x) => x.name === name);
    if (!s) { s = { name, courses: [] }; subjects.push(s); }
    return s;
  };

  for (const cc of state.store.customCourses || []) {
    const s = findSubject(cc.subject);
    let course = s.courses.find((c) => c.key === 'custom:' + cc.id);
    if (!course) {
      course = { key: 'custom:' + cc.id, name: cc.name, path: cc.sourceDir || '', custom: cc, episodes: [], docs: [] };
      s.courses.push(course);
    }
    course.episodes = sortEpisodes((cc.videos || []).map(makeEpisode));
    course.docs = (cc.docs || []).map((d) => ({ path: d.path, name: d.path.split(/[\\/]/).pop(), episodeIndex: null }));
  }

  // 手动挂到已扫描课程上的讲义 + 忽略清单 + 全量重新匹配（手动关联优先）
  const ignored = state.store.docsIgnored || {};
  const binds = state.store.docBinds || {};
  for (const s of subjects) {
    for (const c of s.courses) {
      if (ignored[c.path]) c.docs = c.docs.filter((d) => !ignored[c.path].includes(d.path));
      const extra = (state.store.docsByCourse || {})[c.path];
      if (extra) c.docs.push(...extra.map((p) => ({ path: p, name: p.split(/[\\/]/).pop(), episodeIndex: null })));
      if (!c.key) c.key = c.path;
      matchDocs(c, binds);
    }
  }
  state.subjects = subjects;
}

/* ---------- 侧栏 ---------- */

function courseStats(course) {
  const total = course.episodes.length;
  const done = course.episodes.filter((ep) => state.store.videos[ep.path]?.completed).length;
  return { done, total };
}

function renderSidebar() {
  const tree = $('subjectTree');
  tree.innerHTML = '';
  if (!state.subjects.length) {
    tree.innerHTML = '<div class="ep-empty">还没有科目<br>点右上「目录」添加</div>';
    return;
  }
  for (const s of state.subjects) {
    const div = document.createElement('div');
    div.className = 'subject';
    const head = document.createElement('div');
    head.className = 'subject-name';
    head.innerHTML = `<span class="arrow">▼</span><span>${esc(s.name)}</span>`;
    head.onclick = () => div.classList.toggle('collapsed');
    div.appendChild(head);

    for (const c of s.courses) {
      const item = document.createElement('div');
      item.className = 'course-item' + (state.course === c ? ' active' : '');
      const { done, total } = courseStats(c);
      item.innerHTML = `<span class="c-name" title="${esc(c.path || c.name)}">${esc(c.name)}</span><span class="c-prog">${done}/${total}</span>`;
      item.onclick = () => selectCourse(s, c);
      item.addEventListener('contextmenu', (e) => { e.preventDefault(); refreshDocMatch(c); });
      div.appendChild(item);
    }
    tree.appendChild(div);
  }
}

/* ---------- 分集列表 ---------- */

function renderEpisodes() {
  const list = $('episodeList');
  list.innerHTML = '';
  if (!state.course) { list.innerHTML = '<div class="ep-empty">先在左侧选择课程</div>'; return; }
  const eps = state.course.episodes;
  if (!eps.length) { list.innerHTML = '<div class="ep-empty">该课程暂无视频<br>下载后放入文件夹，或用「＋导入」手动添加</div>'; return; }

  eps.forEach((ep, i) => {
    if (state.filterText && !ep.title.toLowerCase().includes(state.filterText.toLowerCase()) && !ep.filename.toLowerCase().includes(state.filterText.toLowerCase())) return;
    const p = state.store.videos[ep.path];
    const row = document.createElement('div');
    const progress = progressState(p);
    const done = progress === 'done';
    const partial = progress === 'partial';
    row.className = 'ep-row' + (i === state.index ? ' active' : '') + (done ? ' done' : partial ? ' partial' : '');
    const doc = state.course.docs.find((d) => d.episodeIndex === i);
    row.innerHTML =
      `<span class="st">${done ? '✔' : partial ? '▶' : '·'}</span>` +
      `<span class="idx">${i + 1}</span>` +
      `<span class="title" title="${esc(ep.filename)}${ep.playable ? '' : '\n（此格式需用系统播放器打开）'}">${esc(ep.title)}</span>` +
      `<span class="pct">${epRowPctText(p)}</span>` +
      (doc ? `<button class="row-btn doc-btn" title="${esc(doc.name)}">讲义</button>` : '') +
      (state.remuxReady.has(ep.path) ? `<span class="row-ico" title="已转封装，可直接内播">已转</span>` : '') +
      `<button class="row-btn" title="打开所在文件夹">打开</button>`;
    row.dataset.path = ep.path;
    row.onclick = (e) => {
      if (e.target.classList.contains('row-btn')) return;
      playEpisode(i);
    };
    const revealBtn = row.querySelectorAll('.row-btn');
    if (doc) revealBtn[0].onclick = (e) => { e.stopPropagation(); window.api.openPath(doc.path); };
    revealBtn[revealBtn.length - 1].onclick = (e) => { e.stopPropagation(); window.api.reveal(ep.path); };
    list.appendChild(row);
  });
}

/* ---------- 分集元信息：时长补全 + 悬停缩略图预览 ---------- */

const metaCache = new Map(); // path → { thumbPath, duration, noThumb }
let fillToken = 0;           // 换课程后使旧的补全循环作废

function setRowDuration(epPath, duration) {
  const row = document.querySelector(`.ep-row[data-path="${CSS.escape(epPath)}"]`);
  if (row) row.querySelector('.pct').textContent = epRowPctText(state.store.videos[epPath], duration);
}

function rememberDuration(epPath, duration) {
  const p = state.store.videos[epPath] || {};
  if (!p.duration) {
    p.duration = duration;
    state.store.videos[epPath] = p;
    window.api.updateStore({ videos: state.store.videos }); // 持久化后重启不再重复探测
  }
}

// 当前课程后台逐条补全未知时长（ffprobe 在主进程串行，避免 99 集并发卡顿）
async function fillDurations(course) {
  const token = ++fillToken;
  for (const ep of course.episodes) {
    if (token !== fillToken || state.course !== course) return;
    if ((state.store.videos[ep.path]?.duration ?? 0) > 0) continue;
    let m = metaCache.get(ep.path);
    if (!m || m.duration == null) {
      try {
        const r = await window.api.episodeMeta({ path: ep.path, thumb: false, duration: true });
        m = { ...(m || {}), ...(r || {}) };
        metaCache.set(ep.path, m);
      } catch {
        metaCache.set(ep.path, { ...(m || {}), duration: null }); // 失败本次会话不再重试
        continue;
      }
    }
    if (token !== fillToken || state.course !== course) return;
    if ((m.duration ?? 0) > 0) {
      rememberDuration(ep.path, m.duration);
      setRowDuration(ep.path, m.duration);
    }
  }
}

/* 悬停预览：固定停靠在分集列表右侧（避免 CSP 拦动态内联定位） */
let hoverTimer = null;
let hoverPath = null;
let previewPath = null; // 当前预览显示的分集（缓存文件失效时重抽用）

function setPreviewImg(thumbPath) {
  const img = $('hpImg');
  if (thumbPath) {
    img.src = window.api.mediaUrl(thumbPath);
    img.classList.remove('hidden');
    $('hpNoImg').classList.add('hidden');
  } else {
    img.classList.add('hidden');
    img.removeAttribute('src');
    $('hpNoImg').classList.remove('hidden');
  }
}

function hidePreview() {
  hoverPath = null;
  clearTimeout(hoverTimer);
  hoverTimer = null;
  $('hoverPreview').classList.add('hidden');
}

async function showPreview(epPath) {
  const ep = state.course?.episodes.find((e) => e.path === epPath);
  if (!ep || hoverPath !== epPath) return;
  previewPath = epPath;
  $('hoverPreview').classList.remove('hidden');
  $('hpName').textContent = ep.filename;
  const known = state.store.videos[epPath]?.duration;
  $('hpSub').textContent = known ? `时长 ${fmtTime(known)} · ${state.course.name}` : state.course.name;

  let m = metaCache.get(epPath);
  setPreviewImg(m?.thumbPath || null);
  if (m?.thumbPath || m?.noThumb) return;

  let r = null;
  try { r = await window.api.episodeMeta({ path: epPath, thumb: true, duration: false, durationHint: known }); } catch { /* 忽略 */ }
  if (hoverPath !== epPath) return;
  metaCache.set(epPath, { ...(m || {}), thumbPath: r?.thumbPath || null, duration: r?.duration ?? m?.duration, noThumb: !r?.thumbPath });
  if ((r?.duration ?? 0) > 0) {
    if (!known) rememberDuration(epPath, r.duration);
    $('hpSub').textContent = `时长 ${fmtTime(r.duration)} · ${state.course.name}`;
  }
  setPreviewImg(r?.thumbPath || null);
}

const epListBox = $('episodeList');
epListBox.addEventListener('mouseover', (e) => {
  const row = e.target.closest('.ep-row');
  if (!row || row.dataset.path === hoverPath) return;
  hoverPath = row.dataset.path;
  clearTimeout(hoverTimer);
  hoverTimer = setTimeout(() => showPreview(hoverPath), 300);
});
epListBox.addEventListener('mouseleave', hidePreview);
epListBox.addEventListener('click', (e) => { if (e.target.closest('.ep-row')) hidePreview(); });
$('hpImg').addEventListener('error', () => {
  $('hpImg').classList.add('hidden');
  $('hpNoImg').classList.remove('hidden');
  // 磁盘缓存文件被删/失效（如清空 thumbnails 目录）→ 清内存缓存并重抽一次
  const p = previewPath;
  const m = p ? metaCache.get(p) : null;
  if (p && m?.thumbPath) {
    m.thumbPath = null;
    m.noThumb = false;
    if (hoverPath === p) showPreview(p);
  }
});

/* ---------- 课程选择 / 播放 ---------- */

function selectCourse(subject, course, autoplayEpisode = -1) {
  persistProgressNow();
  hidePreview(); // 换课程时收起上一课程的悬停预览
  state.subject = subject;
  state.course = course;
  state.index = -1;
  state.filterText = '';
  $('searchBox').value = '';
  $('courseTitle').textContent = `${course.name} · ${subject.name}`;
  const { done, total } = courseStats(course);
  const chip = $('progressChip');
  chip.classList.toggle('hidden', !total);
  chip.textContent = `进度 ${done}/${total}`;
  renderSidebar();
  renderEpisodes();
  fillDurations(course); // 后台渐进补全未播放分集的时长
  refreshRemuxBadges(course); // 刷新已转封装分集的 ⚡ 标记

  const hasEps = course.episodes.length > 0;
  $('playerWrap').classList.toggle('hidden', !hasEps);
  $('emptyState').classList.toggle('hidden', hasEps);

  state.store.settings.lastCoursePath = course.key;
  saveSettings();

  if (autoplayEpisode >= 0 && autoplayEpisode < course.episodes.length) {
    playEpisode(autoplayEpisode, { autoplay: false });
  }
}

function playEpisode(i, { autoplay = true } = {}) {
  const course = state.course;
  if (!course || i < 0 || i >= course.episodes.length) return;
  const ep = course.episodes[i];
  state.index = i;
  state.store.settings.lastEpisodePath = ep.path;
  saveSettings();

  $('videoOverlay').classList.add('hidden');
  $('npTitle').textContent = ep.title;
  $('npSub').textContent = `${course.name} · 第 ${i + 1} 集 / 共 ${course.episodes.length} 集`;
  $('playerWrap').classList.remove('hidden');
  $('emptyState').classList.add('hidden');

  state.suppressErrorOnce = false;
  state.lastPos = null; // 换集后从新基准累计学习时长
  if (ep.playable) {
    loadVideo(window.api.mediaUrl(ep.path), autoplay);
  } else {
    playViaRemux(ep, autoplay); // MKV/FLV/TS 等 → 无损转封装后内播
  }
  syncCtlUI();
  renderEpisodes();
}

function loadVideo(url, autoplay) {
  video.src = url;
  video.load();
  video.playbackRate = parseFloat(state.store.settings.rate) || 1;
  video.volume = clamp01(state.store.settings.volume ?? 0.9);
  if (autoplay) video.play().catch(() => { /* 可能被系统策略拦，用户手动点播放 */ });
}

/* ---------- 转封装：进度浮条 + 轮询 + 自动起播 ---------- */

let remuxToken = 0; // 换集后使旧的轮询循环作废

function showRemuxBar(ep, progress) {
  $('rbName').textContent = ep.filename;
  $('rbProg').value = Math.round(progress * 100);
  $('remuxBar').classList.remove('hidden');
}

function hideRemuxBar() {
  $('remuxBar').classList.add('hidden');
}

async function playViaRemux(ep, autoplay) {
  const token = ++remuxToken;
  let st = null;
  try { st = await window.api.remuxStart(ep.path); } catch { /* IPC 异常，走兜底 */ }
  while (st && st.status === 'running') {
    if (token !== remuxToken) return;
    showRemuxBar(ep, st.progress);
    await new Promise((r) => setTimeout(r, 400));
    try { st = await window.api.remuxStatus(ep.path); } catch { st = null; break; }
  }
  if (token !== remuxToken) return;
  hideRemuxBar();
  if (st && st.status === 'ready' && st.file) {
    state.remuxReady.add(ep.path);
    loadVideo(window.api.mediaUrl(st.file), autoplay);
    renderEpisodes(); // 行上加 ⚡ 标记
    return;
  }
  // 编码不兼容 / 失败 / 无 ffmpeg → 一阶段的系统播放器兜底
  const msg = st && st.status === 'no-ffmpeg'
    ? `「${ep.filename}」需 ffmpeg 转封装后才能内播（未检测到 ffmpeg，见设置页说明）`
    : `「${ep.filename}」不是浏览器内核直接支持的格式（如 MKV/RMVB/FLV），请用系统播放器打开`;
  $('ovText').textContent = msg;
  $('videoOverlay').classList.remove('hidden');
}

// 课程切换后刷新「已转封装」⚡ 行标记（只查非 playable 分集）
async function refreshRemuxBadges(course) {
  const targets = course.episodes.filter((ep) => !ep.playable).map((ep) => ep.path);
  if (!targets.length) return;
  let ready = [];
  try { ready = await window.api.remuxCheck(targets); } catch { return; }
  if (state.course !== course) return;
  if (ready.some((p) => !state.remuxReady.has(p))) {
    for (const p of ready) state.remuxReady.add(p);
    renderEpisodes();
  }
}

const clamp01 = (v) => Math.min(1, Math.max(0, v));

/* ---------- 进度持久化 ---------- */

function persistProgressNow() {
  if (!state.course || state.index < 0 || !Number.isFinite(video.currentTime) || !video.duration) return;
  const ep = state.course.episodes[state.index];
  const p = state.store.videos[ep.path] || {};
  const prev = progressState(p);
  p.position = video.currentTime;
  p.duration = video.duration;
  if (!p.completed && isCompleted(video.currentTime, video.duration)) p.completed = true;
  p.lastPlayedAt = new Date().toISOString();
  state.store.videos[ep.path] = p;

  // 学习时长：与上次持久化位置的正增量计入当日（≤60s 视为真实观看，拖动跳变不计）
  if (state.lastPos != null) {
    const delta = watchedDelta(state.lastPos, video.currentTime);
    if (delta > 0) {
      const k = localDateKey();
      state.store.stats.daily[k] = (state.store.stats.daily[k] || 0) + delta;
    }
  }
  state.lastPos = video.currentTime;

  window.api.updateStore({ videos: state.store.videos, stats: state.store.stats });

  const now = progressState(p);
  if (prev !== now) {
    renderEpisodes();
    renderSidebar();
    const { done, total } = courseStats(state.course);
    $('progressChip').textContent = `进度 ${done}/${total}`;
  } else {
    // 就地刷新百分比文字
    const row = document.querySelector(`.ep-row[data-path="${CSS.escape(ep.path)}"] .pct`);
    if (row && !p.completed) row.textContent = epRowPctText(p);
  }
  if (!$('dashboard').classList.contains('hidden')) renderDashboard(); // 看板打开时实时刷新统计
}

function saveSettings() {
  window.api.updateStore({ settings: state.store.settings });
}

/* ---------- 播放器事件 ---------- */

video.addEventListener('loadedmetadata', () => {
  const p = state.course && state.index >= 0 ? state.store.videos[state.course.episodes[state.index].path] : null;
  if (shouldResume(p, video.duration)) {
    video.currentTime = p.position;
  }
  syncCtlUI();
});

video.addEventListener('timeupdate', () => {
  if (!state.seeking && video.duration) {
    $('seekBar').value = Math.round((video.currentTime / video.duration) * 1000);
  }
  $('timeLabel').textContent = `${fmtTime(video.currentTime)} / ${fmtTime(video.duration)}`;
  const now = Date.now();
  if (now - state.lastPersist > 3000 && !video.paused) { state.lastPersist = now; persistProgressNow(); }
});

video.addEventListener('ended', () => {
  persistProgressNow();
  if (state.store.settings.autoNext && state.course && state.index < state.course.episodes.length - 1) {
    playEpisode(state.index + 1);
  }
});

video.addEventListener('play', () => { $('btnPlay').textContent = '⏸'; });
video.addEventListener('pause', () => { $('btnPlay').textContent = '▶'; persistProgressNow(); });

video.addEventListener('error', () => {
  if (!state.course || state.index < 0) return;
  const ep = state.course.episodes[state.index];
  if (state.suppressErrorOnce) return;
  state.suppressErrorOnce = true;
  console.error('[video] error code=', video.error?.code, 'src=', video.currentSrc);
  $('ovText').textContent = ep.playable
    ? `播放失败：${ep.filename}\n（可能是编码不受支持）`
    : `「${ep.filename}」不是浏览器内核直接支持的格式（如 MKV/RMVB/FLV），请用系统播放器打开`;
  $('videoOverlay').classList.remove('hidden');
});

$('ovOpenSys').onclick = () => {
  if (state.course && state.index >= 0) window.api.openPath(state.course.episodes[state.index].path);
};
$('ovReveal').onclick = () => {
  if (state.course && state.index >= 0) window.api.reveal(state.course.episodes[state.index].path);
};

/* ---------- 控制条 ---------- */

function syncCtlUI() {
  $('btnPlay').textContent = video.paused ? '▶' : '⏸';
  $('volBar').value = Math.round(video.volume * 100);
  $('btnMute').textContent = video.muted || video.volume === 0 ? '🔇' : '🔊';
  $('speedSel').value = String(video.playbackRate);
  $('seekBar').value = video.duration ? Math.round((video.currentTime / video.duration) * 1000) : 0;
}

$('btnPlay').onclick = () => (video.paused ? video.play() : video.pause());
$('btnPrev').onclick = () => state.index > 0 && playEpisode(state.index - 1);
$('btnNext').onclick = () => state.course && state.index < state.course.episodes.length - 1 && playEpisode(state.index + 1);

$('seekBar').addEventListener('input', () => { state.seeking = true; });
$('seekBar').addEventListener('change', () => {
  if (video.duration) video.currentTime = ($('seekBar').value / 1000) * video.duration;
  state.seeking = false;
});

$('volBar').addEventListener('input', () => {
  video.volume = $('volBar').value / 100;
  video.muted = false;
  state.store.settings.volume = video.volume;
  saveSettings();
  $('btnMute').textContent = video.volume === 0 ? '🔇' : '🔊';
});
$('btnMute').onclick = () => {
  video.muted = !video.muted;
  $('btnMute').textContent = video.muted ? '🔇' : '🔊';
};

$('speedSel').addEventListener('change', () => {
  video.playbackRate = parseFloat($('speedSel').value);
  state.store.settings.rate = video.playbackRate;
  saveSettings();
});

$('btnFull').onclick = toggleFullscreen;
video.addEventListener('dblclick', toggleFullscreen);
video.addEventListener('click', () => (video.paused ? video.play() : video.pause()));

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else $('playerWrap').requestFullscreen().catch(() => {});
}

/* ---------- 快捷键 ---------- */

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
    e.preventDefault();
    gsInput.focus();
    gsInput.select();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'i') { // AI 侧边栏开关（textarea 内也生效）
    e.preventDefault();
    if (window.toggleAI) window.toggleAI();
    return;
  }
  if (['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
  const hasCourse = state.course && state.index >= 0;
  switch (e.key) {
    case ' ': e.preventDefault(); if (hasCourse) { video.paused ? video.play().catch(() => {}) : video.pause(); } break;
    case 'ArrowLeft': if (hasCourse) video.currentTime -= e.shiftKey ? 30 : 5; break;
    case 'ArrowRight': if (hasCourse) video.currentTime += e.shiftKey ? 30 : 5; break;
    case 'ArrowUp': e.preventDefault(); video.volume = clamp01(video.volume + 0.05); $('volBar').value = video.volume * 100; break;
    case 'ArrowDown': e.preventDefault(); video.volume = clamp01(video.volume - 0.05); $('volBar').value = video.volume * 100; break;
    case 'f': case 'F': toggleFullscreen(); break;
    case 'm': case 'M': $('btnMute').click(); break;
    case 'n': case 'N': $('btnNext').click(); break;
    case 'p': case 'P': $('btnPrev').click(); break;
    default:
      if (/^[0-9]$/.test(e.key) && hasCourse && video.duration) {
        video.currentTime = (parseInt(e.key, 10) / 10) * video.duration;
      }
  }
});

/* 键盘优先：点击后收回焦点。
 * 不收的话焦点滞留在按钮/输入框/进度条上——空格变成再触发按钮或输入空格、
 * 方向键变成移动光标或微调滑块，播放器快捷键全部"失灵"。 */
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.closest) {
    const btn = t.closest('button');
    if (btn) { btn.blur(); return; } // 防空格再次触发刚点过的按钮（AI/首页/收起等）
  }
  if (t.type === 'range') { t.blur(); return; } // 点/拖完进度、音量条 → 方向键仍走快退快进
  const a = document.activeElement;
  if (a && a !== t && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA') && !(a.contains(t))) {
    a.blur(); // 点击输入框以外任意区域 → 收回输入焦点（视频/分集行/看板…）
  }
});
// 选完倍速/拖完滑块后 select/range 仍持焦点，方向键会被它截走
document.addEventListener('change', (e) => {
  const t = e.target;
  if (t.tagName === 'SELECT' || t.type === 'range') t.blur();
});

/* ---------- 面板宽度拖动（分隔条） ---------- */

const PW_DEFAULT = { sidebar: 232, episodes: 320, ai: 360 };
const PW_RANGE = { sidebar: [170, 400], episodes: [220, 560], ai: [280, 620] };

// 启动恢复 + 拖动中实时应用（CSSOM 不受 CSP 限制，见坑表）
function applyPanelWidths() {
  const s = state.store.settings.panelWidths = { ...PW_DEFAULT, ...(state.store.settings.panelWidths || {}) };
  $('sidebar').style.width = s.sidebar + 'px';
  $('episodePanel').style.width = s.episodes + 'px';
  $('aiPanel').style.width = s.ai + 'px';
  updateHoverPreviewLeft();
}

// 悬停预览是静态停靠（CSP 下不能动态定位属性），其 left 依赖两栏实际宽度
function updateHoverPreviewLeft() {
  const left = $('sidebar').getBoundingClientRect().width + $('episodePanel').getBoundingClientRect().width + 12;
  $('hoverPreview').style.left = left + 'px';
}

// dir=1 拖右加宽（右缘把手）；dir=-1 拖右变窄（AI 面板左缘把手）
const PANEL_IDS = { sidebar: 'sidebar', episodes: 'episodePanel', ai: 'aiPanel' };
function setupSplitter(handleId, panelId, key, dir) {
  const handle = $(handleId), panel = $(panelId);
  const range = PW_RANGE[key];
  const setW = (w) => {
    // 动态上限：其余两栏现宽 + 3 根把手 + 播放器最小可用宽，防止把播放器挤没
    const othersW = Object.keys(PANEL_IDS).filter((k) => k !== key)
      .reduce((s, k) => s + $(PANEL_IDS[k]).getBoundingClientRect().width, 0);
    const max = Math.min(range[1], Math.max(range[0], document.documentElement.clientWidth - othersW - 21 - 320));
    w = Math.round(Math.min(max, Math.max(range[0], w)));
    state.store.settings.panelWidths[key] = w;
    panel.style.width = w + 'px';
    if (key !== 'ai') updateHoverPreviewLeft();
    return w;
  };
  handle.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (handle.classList.contains('dragging')) return; // 防重入（上一拖未正常收尾时）
    const startX = e.clientX;
    const startW = panel.getBoundingClientRect().width;
    handle.classList.add('dragging');
    // window 级监听（浏览器在鼠标拖动期间隐式捕获，指针出窗也不丢事件）
    const onMove = (ev) => {
      if (!(ev.buttons & 1)) return; // 拖动中松键在外未收到 up → 移动时兜底停止
      setW(startW + dir * (ev.clientX - startX));
    };
    const onUp = () => {
      handle.classList.remove('dragging');
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      saveSettings(); // 拖完落盘，重启沿用
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  });
  handle.addEventListener('dblclick', () => {
    setW(PW_DEFAULT[key]);
    saveSettings();
    showToast('已恢复默认宽度');
  });
}

/* ---------- 轻提示 ---------- */

// 由 boot() 注入 ui/toast 的实例；保留同名函数供 ai.js 与旧调用点使用
let toastView = null;
function showToast(text) {
  toastView?.show(text);
}

/* ---------- 讲义下拉 + 管理 ---------- */

$('btnDocs').onclick = (e) => {
  e.stopPropagation();
  const menu = $('docsMenu');
  if (menu.classList.contains('hidden')) renderDocsMenu();
  menu.classList.toggle('hidden');
};
document.addEventListener('click', (e) => {
  if (!$('docsMenu').contains(e.target) && e.target !== $('btnDocs')) $('docsMenu').classList.add('hidden');
});

function renderDocsMenu() {
  const box = $('docsList');
  box.innerHTML = '';
  const docs = state.course ? state.course.docs : [];
  if (!docs.length) {
    box.innerHTML = '<div class="doc-empty">本课程暂无讲义/习题<br>把 PDF 等文件放进课程文件夹，<br>或用「＋导入 → 讲义习题」添加</div>';
    return;
  }
  const canBind = !!(state.course && state.index >= 0);
  for (const d of docs) {
    const item = document.createElement('div');
    item.className = 'doc-item';
    const scope = d.episodeIndex == null ? '课程资料' : `第 ${d.episodeIndex + 1} 集`;
    item.innerHTML =
      `<span class="d-name" title="${esc(d.path)}">${esc(d.name)}</span>` +
      `<span class="d-scope">${scope}</span>` +
      `<span class="d-actions">` +
      (canBind ? `<button class="d-btn" data-act="bind" aria-label="关联到当前分集" title="关联到当前分集（第 ${state.index + 1} 集）">关联</button>` : '') +
      `<button class="d-btn" data-act="del" aria-label="移除讲义" title="从本课程移除（重启不复活）">✕</button>` +
      `</span>`;
    item.onclick = () => window.api.openPath(d.path);
    item.querySelectorAll('.d-btn').forEach((b) => {
      b.onclick = (e) => {
        e.stopPropagation();
        if (b.dataset.act === 'bind') bindDocToCurrent(d);
        else removeDoc(d);
      };
    });
    box.appendChild(item);
  }
}

function bindDocToCurrent(d) {
  if (!state.course || state.index < 0) return;
  state.store.docBinds[d.path] = state.index;
  d.episodeIndex = state.index;
  window.api.updateStore({ docBinds: state.store.docBinds });
  renderDocsMenu();
  renderEpisodes();
  showToast(`已关联「${d.name}」→ 第 ${state.index + 1} 集`);
}

function removeDoc(d) {
  const course = state.course;
  if (!course) return;
  const store = state.store;
  if (course.custom) {
    const cc = store.customCourses.find((c) => 'custom:' + c.id === course.key);
    if (cc) cc.docs = cc.docs.filter((x) => x.path !== d.path);
  } else if ((store.docsByCourse[course.path] || []).includes(d.path)) {
    store.docsByCourse[course.path] = store.docsByCourse[course.path].filter((p) => p !== d.path);
    if (!store.docsByCourse[course.path].length) delete store.docsByCourse[course.path];
  } else {
    // 扫描发现的讲义：进忽略清单，重启重扫不复活
    store.docsIgnored[course.path] = store.docsIgnored[course.path] || [];
    if (!store.docsIgnored[course.path].includes(d.path)) store.docsIgnored[course.path].push(d.path);
  }
  delete store.docBinds[d.path];
  window.api.updateStore({
    customCourses: store.customCourses, docsByCourse: store.docsByCourse,
    docsIgnored: store.docsIgnored, docBinds: store.docBinds,
  });
  course.docs = course.docs.filter((x) => x.path !== d.path);
  renderDocsMenu();
  renderEpisodes();
  showToast('已移除该讲义');
}

function refreshDocMatch(course) {
  matchDocs(course, state.store.docBinds);
  renderEpisodes();
  renderDocsMenu();
  showToast(`已重新匹配「${course.name}」的讲义`);
}

$('docRefresh').onclick = (e) => {
  e.stopPropagation();
  if (state.course) refreshDocMatch(state.course);
};

/* ---------- 目录添加 ---------- */

async function addDirectories() {
  const paths = await window.api.pickFolders();
  const added = [];
  for (const p of paths) {
    if (!state.store.roots.includes(p)) { state.store.roots.push(p); added.push(p); }
  }
  if (!added.length) return;
  window.api.updateStore({ roots: state.store.roots });
  await rebuildTree();
  renderSidebar();
  // 自动选中新目录的第一个课程
  const rootName = added[0].split(/[\\/]/).filter(Boolean).pop();
  const s = state.subjects.find((x) => x.name === rootName) || state.subjects[0];
  if (s && s.courses.length) selectCourse(s, s.courses[0]);
}

$('btnAddDir').onclick = addDirectories;
$('emptyOpenDir').onclick = addDirectories;
$('emptyImport').onclick = () => importViaDialog();
$('btnImport').onclick = () => importViaDialog();

async function importViaDialog() {
  const paths = await window.api.pickFiles();
  if (!paths.length) return;
  const videos = paths.filter((p) => isVideoFile(p));
  const docs = paths.filter((p) => isDocFile(p));
  if (videos.length) openImportModal({ type: 'videos', files: videos });
  else if (docs.length) openImportModal({ type: 'docs', files: docs });
}

/* ---------- 导入弹窗 ---------- */

let importCtx = null;

function openImportModal(ctx) {
  importCtx = ctx;
  const titles = { videos: '导入视频', folder: '导入课程文件夹', docs: '导入讲义 / 习题' };
  $('importTitle').textContent = titles[ctx.type];

  let summary = '';
  if (ctx.type === 'folder') {
    summary = ctx.dirs.join('<br>') + `<br>共 ${ctx.dirs.length} 个课程文件夹（内部视频自动成集、文档自动归为讲义）`;
  } else {
    const items = ctx.files.map((f) => `· ${f.split(/[\\/]/).pop()}`);
    summary = items.slice(0, 8).join('<br>') + (items.length > 8 ? `<br>… 共 ${items.length} 个文件` : '');
  }
  $('importSummary').innerHTML = summary;

  // 科目下拉
  const subjSel = $('impSubject');
  subjSel.innerHTML = state.subjects.map((s) => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('') +
    (ctx.type === 'docs' ? '' : '<option value="__new__">＋ 新建科目…</option>');
  if (!state.subjects.length) subjSel.innerHTML = '<option value="__new__">＋ 新建科目…</option>';
  $('impNewSubjectField').classList.add('hidden');
  $('impNewSubject').value = '';
  refreshCourseOptions();
  $('importModal').classList.remove('hidden');
}

function refreshCourseOptions() {
  const subjName = $('impSubject').value;
  const isNew = subjName === '__new__';
  $('impNewSubjectField').classList.toggle('hidden', !isNew);

  const courseField = $('impCourseField');
  const courseSel = $('impCourse');
  courseField.classList.add('hidden');

  if (importCtx && importCtx.type === 'docs') {
    // 讲义可以挂到任何已有课程
    const all = [];
    for (const s of state.subjects) for (const c of s.courses) all.push({ s, c });
    courseField.classList.toggle('hidden', all.length === 0);
    courseSel.innerHTML = all.map(({ s, c }) => `<option value="${esc(c.key)}">${esc(s.name)} / ${esc(c.name)}</option>`).join('');
  } else if (!isNew) {
    const s = state.subjects.find((x) => x.name === subjName);
    const customs = s ? s.courses.filter((c) => c.custom) : [];
    courseField.classList.remove('hidden');
    courseSel.innerHTML = '<option value="__new__">＋ 新建课程…</option>' +
      customs.map((c) => `<option value="${esc(c.key)}">${esc(c.name)}（已导入课程，追加）</option>`).join('');
    if (customs.length === 0) courseSel.value = '__new__';
  }
  toggleNewCourseField();
}

function toggleNewCourseField() {
  const isNew = $('impCourse').value === '__new__';
  const courseVisible = !$('impCourseField').classList.contains('hidden');
  $('impNewCourseField').classList.toggle('hidden', !(isNew && courseVisible));
  $('impNewCourse').value = '';
}

$('impSubject').addEventListener('change', refreshCourseOptions);
$('impCourse').addEventListener('change', toggleNewCourseField);
$('impCancel').onclick = () => { $('importModal').classList.add('hidden'); importCtx = null; };

$('impConfirm').onclick = async () => {
  if (!importCtx) return;
  let subjName = $('impSubject').value;
  if (subjName === '__new__') {
    subjName = $('impNewSubject').value.trim();
    if (!subjName) { $('impNewSubject').focus(); return; }
  }
  const courseKey = !$('impCourseField').classList.contains('hidden') ? $('impCourse').value : '__new__';
  const courseName = courseKey === '__new__' ? ($('impNewCourse').value.trim() || null) : null;

  const store = state.store;
  let targetCourseKey = null;

  if (importCtx.type === 'videos') {
    const extraDocs = importCtx.extraDocs || [];
    if (courseKey === '__new__') {
      if (!courseName) { $('impNewCourse').focus(); return; }
      const cc = {
        id: 'c' + Date.now().toString(36),
        subject: subjName, name: courseName,
        sourceDir: importCtx.files[0].split(/[\\/]/).slice(0, -1).join(
          importCtx.files[0].lastIndexOf('/') > importCtx.files[0].lastIndexOf('\\') ? '/' : '\\',
        ),
        videos: [...importCtx.files],
        docs: extraDocs.map((p) => ({ path: p })),
      };
      store.customCourses.push(cc);
      targetCourseKey = 'custom:' + cc.id;
    } else {
      const cc = store.customCourses.find((c) => 'custom:' + c.id === courseKey);
      const set = new Set(cc.videos);
      for (const f of importCtx.files) if (!set.has(f)) cc.videos.push(f);
      const docSet = new Set(cc.docs.map((d) => d.path));
      for (const f of extraDocs) if (!docSet.has(f)) cc.docs.push({ path: f });
      targetCourseKey = courseKey;
    }
  } else if (importCtx.type === 'folder') {
    for (const dir of importCtx.dirs) {
      const scanned = await window.api.scanCourse(dir);
      const cc = {
        id: 'c' + Date.now().toString(36) + Math.floor(Math.random() * 100),
        subject: subjName, name: courseName || scanned.name,
        sourceDir: dir,
        videos: scanned.episodes.map((e) => e.path),
        docs: scanned.docs.map((d) => ({ path: d.path })),
      };
      store.customCourses.push(cc);
      targetCourseKey = 'custom:' + cc.id;
    }
  } else if (importCtx.type === 'docs') {
    if (!courseKey || courseKey === '__new__' || !state.subjects.length) {
      // 没有可选课程 → 建一个仅放讲义的课程
      const cc = {
        id: 'c' + Date.now().toString(36),
        subject: subjName, name: courseName || '讲义资料',
        sourceDir: '', videos: [], docs: importCtx.files.map((p) => ({ path: p })),
      };
      store.customCourses.push(cc);
      targetCourseKey = 'custom:' + cc.id;
    } else {
      // 已有课程：自定义课程挂 cc.docs，扫描课程挂 docsByCourse
      const cc = store.customCourses.find((c) => 'custom:' + c.id === courseKey);
      if (cc) {
        const set = new Set(cc.docs.map((d) => d.path));
        for (const f of importCtx.files) if (!set.has(f)) cc.docs.push({ path: f });
      } else {
        const course = findCourseByKey(courseKey);
        if (course) {
          store.docsByCourse[course.path] = store.docsByCourse[course.path] || [];
          const set = new Set(store.docsByCourse[course.path]);
          for (const f of importCtx.files) if (!set.has(f)) store.docsByCourse[course.path].push(f);
        }
      }
      targetCourseKey = courseKey;
    }
  }

  window.api.updateStore({
    customCourses: store.customCourses,
    docsByCourse: store.docsByCourse,
  });
  $('importModal').classList.add('hidden');
  importCtx = null;
  await rebuildTree();
  renderSidebar();
  const target = findCourseByKey(targetCourseKey);
  if (target) {
    const s = state.subjects.find((x) => x.courses.includes(target));
    selectCourse(s, target);
  }
};

function findCourseByKey(key) {
  for (const s of state.subjects) {
    const c = s.courses.find((c) => c.key === key);
    if (c) return c;
  }
  return null;
}

/* ---------- 拖拽导入 ---------- */

let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropHint').classList.remove('hidden'); });
document.addEventListener('dragleave', (e) => { e.preventDefault(); if (--dragDepth <= 0) { dragDepth = 0; $('dropHint').classList.add('hidden'); } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', async (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropHint').classList.add('hidden');
  const files = [...e.dataTransfer.files];
  if (!files.length) return;
  const paths = (await window.api.dropPaths(files)).filter(Boolean);
  const dirs = [], vids = [], docs = [];
  for (const p of paths) {
    if (isVideoFile(p)) vids.push(p);
    else if (isDocFile(p)) docs.push(p);
    else dirs.push(p); // 无扩展名 → 视为文件夹
  }
  if (dirs.length) {
    openImportModal({ type: 'folder', dirs });
  } else if (vids.length) {
    // 同时拖入了讲义 → 随视频一起挂到目标课程
    openImportModal({ type: 'videos', files: vids, extraDocs: docs });
  } else if (docs.length) {
    openImportModal({ type: 'docs', files: docs });
  }
});

/* ---------- 搜索（分集内过滤） ---------- */

$('searchBox').addEventListener('input', () => {
  state.filterText = $('searchBox').value.trim();
  renderEpisodes();
});

/* ---------- 全局搜索（Ctrl+K） ---------- */

const gsInput = $('globalSearch');
const gsDrop = $('searchDrop');
let gsItems = [];
let gsIndex = -1;

function globalSearchUpdate() {
  const result = searchLibrary(state.subjects, gsInput.value);
  gsItems = result.items;
  gsIndex = gsItems.length ? 0 : -1;
  if (!result.query) { gsDrop.classList.add('hidden'); return; }
  renderGsDrop();
  gsDrop.classList.remove('hidden');
}

function renderGsDrop() {
  if (!gsItems.length) { gsDrop.innerHTML = '<div class="gs-empty">没有匹配的课程或分集</div>'; return; }
  let html = '';
  const courses = gsItems.filter((it) => it.type === 'course');
  const eps = gsItems.filter((it) => it.type === 'ep');
  if (courses.length) {
    html += '<div class="gs-group">课程</div>';
    courses.forEach((it) => {
      html += `<div class="gs-item${gsItems[gsIndex] === it ? ' on' : ''}" data-id="${gsItems.indexOf(it)}"><span class="g-label">${esc(it.course.name)}</span><span class="g-sub">${esc(it.subject.name)}</span></div>`;
    });
  }
  if (eps.length) {
    html += '<div class="gs-group">分集</div>';
    eps.forEach((it) => {
      html += `<div class="gs-item${gsItems[gsIndex] === it ? ' on' : ''}" data-id="${gsItems.indexOf(it)}"><span class="g-label">${esc(it.ep.title)}</span><span class="g-sub">${esc(it.course.name)} · 第 ${it.idx + 1} 集</span></div>`;
    });
  }
  gsDrop.innerHTML = html;
}

function gsExec(item) {
  gsDrop.classList.add('hidden');
  gsInput.blur();
  if (!item) return;
  showMainView();
  selectCourse(item.subject, item.course);
  if (item.type === 'ep') playEpisode(item.idx, { autoplay: true });
}

function gsMove(d) {
  if (!gsItems.length) return;
  gsIndex = (gsIndex + d + gsItems.length) % gsItems.length;
  renderGsDrop();
  gsDrop.querySelector('.gs-item.on')?.scrollIntoView({ block: 'nearest' });
}

gsInput.addEventListener('input', globalSearchUpdate);
gsInput.addEventListener('focus', globalSearchUpdate);
gsInput.addEventListener('blur', () => gsDrop.classList.add('hidden'));
gsInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown') { e.preventDefault(); gsMove(1); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); gsMove(-1); }
  else if (e.key === 'Enter') { e.preventDefault(); gsExec(gsItems[gsIndex]); }
  else if (e.key === 'Escape') { gsDrop.classList.add('hidden'); gsInput.blur(); }
});
gsDrop.addEventListener('mousedown', (e) => {
  const el = e.target.closest('.gs-item');
  if (el) { e.preventDefault(); gsExec(gsItems[+el.dataset.id]); } // preventDefault 保证不先触发 blur
});

/* ---------- 学习看板（首页） ---------- */

function showDashboard() {
  $('dashboard').classList.remove('hidden');
  $('main').classList.add('hidden');
  $('btnHome').classList.add('on');
  renderDashboard();
}

function showMainView() {
  $('dashboard').classList.add('hidden');
  $('main').classList.remove('hidden');
  $('btnHome').classList.remove('on');
}

$('btnHome').onclick = () => {
  if ($('dashboard').classList.contains('hidden')) showDashboard();
  else showMainView();
};

function renderDashboard() {
  /* 继续学习 */
  const cont = $('dashContinue');
  const s = state.store.settings;
  const course = s.lastCoursePath ? findCourseByKey(s.lastCoursePath) : null;
  const epIdx = course ? course.episodes.findIndex((e) => e.path === s.lastEpisodePath) : -1;
  const ep = course && epIdx >= 0 ? course.episodes[epIdx] : null;
  const p = ep ? state.store.videos[ep.path] : null;
  if (course && ep && p && p.position > 10 && p.duration && !p.completed) {
    const pct = Math.min(100, Math.round((p.position / p.duration) * 100));
    cont.innerHTML =
      '<div class="dash-sec-title">继续学习</div>' +
      `<div class="cont-card" id="contCard">` +
      `<div class="cont-noimg" id="contNoImg">暂无预览</div>` +
      `<img id="contThumb" class="hidden" alt="">` +
      `<div class="cont-info">` +
      `<div class="cont-course">${esc(course.name)}</div>` +
      `<div class="cont-title">${esc(ep.title)}</div>` +
      `<div class="cont-sub">第 ${epIdx + 1} 集 / 共 ${course.episodes.length} 集 · 已看 ${fmtTime(p.position)}（${pct}%）</div>` +
      `<progress class="cont-bar" max="100" value="${pct}"></progress>` +
      `</div>` +
      `<button class="big-btn">继续播放</button>` +
      `</div>`;
    $('contCard').onclick = async () => {
      showMainView();
      const subj = state.subjects.find((x) => x.courses.includes(course));
      selectCourse(subj, course, epIdx);
      video.play().catch(() => {});
    };
    // 缩略图异步补（悬停/看板共用磁盘缓存）
    (async () => {
      let thumb = metaCache.get(ep.path)?.thumbPath;
      if (!thumb) {
        try {
          const r = await window.api.episodeMeta({ path: ep.path, thumb: true, duration: true, durationHint: p.duration });
          if (r?.thumbPath) {
            metaCache.set(ep.path, { ...(metaCache.get(ep.path) || {}), ...r });
            thumb = r.thumbPath;
          }
        } catch { /* 无 ffmpeg 或失败则保持占位 */ }
      }
      const img = $('contThumb');
      if (thumb && img) {
        img.src = window.api.mediaUrl(thumb);
        img.classList.remove('hidden');
        $('contNoImg')?.classList.add('hidden');
      }
    })();
  } else {
    cont.innerHTML = '<div class="dash-sec-title">继续学习</div><div class="cont-none">没有待续播的分集，去左侧挑一集开始吧</div>';
  }

  /* 科目进度 */
  let html = '<div class="dash-sec-title">科目进度</div>';
  for (const subj of state.subjects) {
    let done = 0, total = 0;
    for (const c of subj.courses) { const st = courseStats(c); done += st.done; total += st.total; }
    html += `<div class="subj-row"><span class="s-name">${esc(subj.name)}</span>` +
      `<progress class="s-bar" max="100" value="${total ? Math.round((done / total) * 100) : 0}"></progress>` +
      `<span class="s-frac">${done}/${total}</span></div>`;
  }
  if (!state.subjects.length) html += '<div class="cont-none">还没有添加学习目录</div>';
  $('dashSubjects').innerHTML = html;

  /* 本周学习 */
  const daily = state.store.stats.daily || {};
  let weekSec = 0, activeDays = 0;
  for (let i = 0; i < 7; i++) {
    const v = daily[localDateKey(new Date(Date.now() - i * 86400000))] || 0;
    weekSec += v;
    if (v > 0) activeDays++;
  }
  const weekAgo = Date.now() - 7 * 86400000;
  let doneWeek = 0;
  for (const k in state.store.videos) {
    const v = state.store.videos[k];
    if (v.completed && v.lastPlayedAt && Date.parse(v.lastPlayedAt) >= weekAgo) doneWeek++;
  }
  $('dashWeek').innerHTML = '<div class="dash-sec-title">本周学习</div>' +
    `<div class="week-cards">` +
    `<div class="w-card"><div class="w-num">${activeDays}</div><div class="w-label">活跃天数</div></div>` +
    `<div class="w-card"><div class="w-num">${doneWeek}</div><div class="w-label">看完集数</div></div>` +
    `<div class="w-card"><div class="w-num w-dur">${fmtDur(weekSec)}</div><div class="w-label">累计观看</div></div>` +
    `<div class="w-card"><div class="w-num w-dur">${fmtDur(daily[localDateKey()] || 0)}</div><div class="w-label">今日时长</div></div>` +
    `</div>`;
}

$('btnTheme').onclick = () => {
  const next = document.body.classList.contains('light') ? 'dark' : 'light';
  applyTheme(next);
  localStorage.setItem('theme', next);
  state.store.settings.theme = next;
  saveSettings();
};

/* ---------- 设置弹窗 ---------- */

$('btnSettings').onclick = () => { renderSettings(); $('settingsModal').classList.remove('hidden'); };
$('setClose').onclick = () => { $('settingsModal').classList.add('hidden'); };
$('openDataDir').onclick = (e) => { e.preventDefault(); window.api.openUserData(); };
$('setAutoNext').addEventListener('change', () => {
  state.store.settings.autoNext = $('setAutoNext').checked;
  saveSettings();
});

function renderSettings() {
  const box = $('rootList');
  box.innerHTML = '';
  if (!state.store.roots.length) {
    box.innerHTML = '<div class="hint-row">尚未添加学习目录</div>';
  }
  for (const r of state.store.roots) {
    const item = document.createElement('div');
    item.className = 'root-item';
    item.innerHTML = `<span class="rp">${esc(r)}</span><button title="移除">✕</button>`;
    item.querySelector('button').onclick = async () => {
      state.store.roots = state.store.roots.filter((x) => x !== r);
      window.api.updateStore({ roots: state.store.roots });
      await rebuildTree();
      renderSidebar();
      renderSettings();
    };
    box.appendChild(item);
  }
  $('setAutoNext').checked = !!state.store.settings.autoNext;
  renderCacheRows();
}

// 缩略图 / 转封装缓存占用与一键清理
async function renderCacheRows() {
  const box = $('cacheList');
  if (!box) return;
  let stats;
  try { stats = await window.api.cacheStats(); } catch { box.innerHTML = ''; return; }
  const rows = [
    { key: 'thumbnails', label: '缩略图缓存', st: stats.thumbnails },
    { key: 'remux', label: '转封装缓存', st: stats.remux },
  ];
  box.innerHTML = '';
  for (const r of rows) {
    const item = document.createElement('div');
    item.className = 'root-item';
    item.innerHTML = `<span class="rp">${r.label}：${r.st.files} 个文件 · ${fmtBytes(r.st.bytes)}</span><button title="一键清理">清理</button>`;
    item.querySelector('button').onclick = async () => {
      await window.api.cacheClear(r.key);
      if (r.key === 'thumbnails') metaCache.forEach((m) => { m.thumbPath = null; m.noThumb = false; }); // 强制下次悬停重抽
      showToast(`已清理${r.label}`);
      renderCacheRows();
    };
    box.appendChild(item);
  }
}

/* ---------- 工具 ---------- */

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- 启动 ---------- */

(async function boot() {
  // 先载入 core / ui（lib-boot.js 的 Promise），再注入本文件的全局绑定
  const libs = await window.LibsReady;
  ({
    sortEpisodes, makeEpisode,
    fmtTime, fmtDur, fmtBytes, localDateKey,
    matchDocs, progressState, isCompleted, shouldResume, watchedDelta,
    searchLibrary, isVideoFile, isDocFile,
  } = libs.core);
  toastView = libs.ui.createToast($('toast'));

  state.store = await window.api.getStore();
  // 以 learn.json 的持久偏好校正主题（localStorage 只是绘制缓存）
  const savedTheme = state.store.settings.theme || 'dark';
  if (savedTheme !== (localStorage.getItem('theme') || 'dark')) applyTheme(savedTheme);
  localStorage.setItem('theme', savedTheme);
  applyPanelWidths(); // 恢复上次的栏宽
  setupSplitter('sbSplit', 'sidebar', 'sidebar', 1);
  setupSplitter('epSplit', 'episodePanel', 'episodes', 1);
  setupSplitter('aiSplit', 'aiPanel', 'ai', -1);
  await rebuildTree();
  renderSidebar();

  const hasAny = state.subjects.some((s) => s.courses.length);
  $('emptyState').classList.toggle('hidden', hasAny);

  // 恢复上次课程
  const lastKey = state.store.settings.lastCoursePath;
  const course = lastKey ? findCourseByKey(lastKey) : null;
  if (course) {
    const s = state.subjects.find((x) => x.courses.includes(course));
    const epIdx = course.episodes.findIndex((ep) => ep.path === state.store.settings.lastEpisodePath);
    selectCourse(s, course, epIdx);
  }

  document.addEventListener('visibilitychange', () => { if (document.hidden) persistProgressNow(); });
  window.addEventListener('beforeunload', () => persistProgressNow());
})();
