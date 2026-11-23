const { app, BrowserWindow, ipcMain, dialog, shell, webUtils } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { registerAiIpc } = require('./ai-bridge');
const { findFfTools: detectFfTools } = require('./platform');

const WIN_SIZE = { width: 1360, height: 860 };

// 测试隔离：仅当显式传入 VDS_USER_DATA 时改写用户数据目录（scripts/smoke.mjs 使用）。
// 生产运行不设置该变量，行为与之前完全一致（learn.json 仍在 %APPDATA%\学习播放器\）。
if (process.env.VDS_USER_DATA) {
  try {
    app.setPath('userData', path.resolve(process.env.VDS_USER_DATA));
  } catch (err) {
    console.warn('[test] VDS_USER_DATA 设置失败', err);
  }
}

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    ...WIN_SIZE,
    minWidth: 980,
    minHeight: 620,
    backgroundColor: '#0e1512',
    autoHideMenuBar: true,
    title: '学习播放器',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

/* ---------------- 媒体文件类型（判定逻辑与渲染层共享 core/episode.js） ---------------- */

// core 是 ESM，在 app ready 阶段用动态 import 加载；扫描/IPC 调用都发生在其后
let core = null;
async function loadCore() {
  const { pathToFileURL } = require('node:url');
  core = await import(pathToFileURL(path.join(__dirname, 'renderer', 'core', 'index.js')).href);
}

const isVideo = (p) => core.isVideoFile(p);
const isDoc = (p) => core.isDocFile(p);
const isHiddenDir = (name) => name.startsWith('.') || name === '$RECYCLE.BIN' || name === 'System Volume Information';

/* ---------------- 目录扫描 ---------------- */

function listDirSafe(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch { return []; }
}

function statSafe(p) {
  try { return fs.statSync(p); } catch { return null; }
}

// depth 内（含自身这一层文件）是否有视频
function hasVideoIn(dir, depth) {
  if (depth < 0) return false;
  for (const e of listDirSafe(dir)) {
    if (e.isFile() && isVideo(e.name)) return true;
    if (e.isDirectory() && !isHiddenDir(e.name) && hasVideoIn(path.join(dir, e.name), depth - 1)) return true;
  }
  return false;
}

// 收集课程文件夹内的视频与文档（递归，深度受限）
function collectCourse(dir) {
  const episodes = [];
  const docs = [];
  const walk = (d, depth) => {
    if (depth < 0) return;
    for (const e of listDirSafe(d)) {
      const full = path.join(d, e.name);
      if (e.isFile()) {
        if (isVideo(e.name)) episodes.push(core.makeEpisode(full));
        else if (isDoc(e.name)) docs.push({ path: full, name: e.name });
      } else if (e.isDirectory() && !isHiddenDir(e.name)) {
        walk(full, depth - 1);
      }
    }
  };
  walk(dir, 2);
  core.sortEpisodes(episodes);
  return { episodes, docs };
}

// 扫描课程目录。讲义的分集关联由渲染层用 core/docmatch.js 统一计算
// （主进程不再维护第二套匹配算法；scan-course 只负责收集文件）。
function scanCourse(dir) {
  return { name: path.basename(dir), path: dir, ...collectCourse(dir) };
}

// 扫描一个根目录 → 科目列表
// 规则（见方案）：
//  a) 根的某个一级子文件夹里直接就有视频 → 根本身是科目，一级子文件夹都是课程；
//  b) 否则，一级子文件夹内（更深一层）有视频的当作科目，其子文件夹为课程；无视频的文件夹排除（兼容选到杂物盘根目录）。
function scanRoot(root) {
  const level1 = listDirSafe(root).filter((e) => e.isDirectory() && !isHiddenDir(e.name));
  const anyDirectVideo = level1.some((e) =>
    listDirSafe(path.join(root, e.name)).some((f) => f.isFile() && isVideo(f.name))
  );

  if (anyDirectVideo) {
    return [{ name: path.basename(root), source: root, courses: level1.map((e) => scanCourse(path.join(root, e.name))) }];
  }

  const subjects = [];
  for (const e of level1) {
    const dir = path.join(root, e.name);
    if (!hasVideoIn(dir, 2)) continue; // 杂物文件夹排除
    const courses = listDirSafe(dir)
      .filter((c) => c.isDirectory() && !isHiddenDir(c.name))
      .map((c) => scanCourse(path.join(dir, c.name)));
    subjects.push({ name: e.name, source: dir, courses });
  }
  return subjects;
}

function scanAll(roots) {
  const merged = [];
  for (const root of roots) {
    if (!statSafe(root) || !statSafe(root).isDirectory()) continue;
    for (const subject of scanRoot(root)) {
      const exist = merged.find((s) => s.name === subject.name);
      if (exist) exist.courses.push(...subject.courses);
      else merged.push(subject);
    }
  }
  return merged;
}

/* ---------------- 数据存储 learn.json ---------------- */

const STORE_DEFAULT = {
  roots: [],
  customCourses: [],
  docsByCourse: {},
  docsIgnored: {},   // 讲义忽略清单：{ "<扫描课程目录>": ["<doc路径>"] }（移除扫描发现的讲义用，重启不复活）
  docBinds: {},      // 讲义手动关联：{ "<doc路径>": <分集下标> }
  videos: {},
  stats: { daily: {} }, // 每日累计播放秒数：{ "2026-09-18": 3700 }
  settings: {
    rate: 1, volume: 0.9, autoNext: true, lastCoursePath: '', lastEpisodePath: '', theme: 'dark',
    panelWidths: { sidebar: 232, episodes: 320, ai: 360 }, // 可拖拽分隔条的栏宽（v0.4.3）
  },
  ai: { baseUrl: '', apiKey: '', model: '', contextEnabled: true, systemPrompt: '' }, // M7：AI 侧边栏（OpenAI 兼容配置；key 仅本地存储）
};

function storeFile() {
  return path.join(app.getPath('userData'), 'learn.json');
}

function loadStore() {
  try {
    const raw = fs.readFileSync(storeFile(), 'utf8');
    const data = JSON.parse(raw);
    return {
      ...STORE_DEFAULT, ...data,
      settings: { ...STORE_DEFAULT.settings, ...(data.settings || {}) },
      stats: { daily: { ...(data.stats?.daily || {}) } },
      docsIgnored: { ...(data.docsIgnored || {}) },
      docBinds: { ...(data.docBinds || {}) },
      ai: { ...STORE_DEFAULT.ai, ...(data.ai || {}) },
    };
  } catch {
    return JSON.parse(JSON.stringify(STORE_DEFAULT));
  }
}

let store = null;
let saveTimer = null;
function saveStoreSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { fs.writeFileSync(storeFile(), JSON.stringify(store, null, 2)); } catch (err) { console.error('保存失败:', err); }
  }, 300);
}

/* ---------------- ffmpeg：缩略图 / 时长 ---------------- */

// 查找 ffmpeg/ffprobe：PATH → 常见安装路径；找不到返回 null（相关功能自动降级）
// 平台差异（where/which、可执行名、候选目录）集中在 platform.js；这里只做会话缓存。
let ffTools = undefined; // undefined=未查找, null=未找到, {ffmpeg, ffprobe}=可用
function findFfTools() {
  if (ffTools !== undefined) return ffTools;
  ffTools = detectFfTools();
  if (!ffTools) console.warn('[ffmpeg] 未找到，缩略图/时长功能降级');
  return ffTools;
}

function thumbDir() {
  const dir = path.join(app.getPath('userData'), 'thumbnails');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 缓存键 = md5(路径|修改时间|大小)，文件变化即失效重抽
function thumbCacheFile(p, st) {
  const key = crypto.createHash('md5').update(`${p}|${st.mtimeMs}|${st.size}`).digest('hex');
  return path.join(thumbDir(), `${key}.jpg`);
}

// ffmpeg/ffprobe 任务串行队列（避免大目录悬停时并发多个转码进程）
let ffChain = Promise.resolve();
function runQueued(job) {
  const p = ffChain.then(job, job);
  ffChain = p.catch(() => {});
  return p;
}

function runTool(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try { child = spawn(bin, args, { windowsHide: true }); } catch { resolve(null); return; }
    let out = '';
    let settled = false;
    const finish = (val) => { if (!settled) { settled = true; resolve(val); } };
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', () => {});
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code === 0 ? out : null));
    setTimeout(() => { try { child.kill(); } catch {} finish(null); }, timeoutMs);
  });
}

async function probeDuration(file) {
  const out = await runTool(findFfTools().ffprobe,
    ['-v', 'quiet', '-show_entries', 'format=duration', '-of', 'csv=p=0', file], 8000);
  const dur = out == null ? NaN : parseFloat(String(out).trim());
  return Number.isFinite(dur) && dur > 0 ? dur : null;
}

async function genThumb(src, outFile, duration) {
  const pos = Math.max(0, Math.min(30, (duration || 60) * 0.1));
  const tmp = outFile + '.part.jpg';
  const ok = await runTool(findFfTools().ffmpeg,
    ['-ss', pos.toFixed(2), '-i', src, '-frames:v', '1', '-vf', 'scale=260:-2', '-q:v', '5', '-y', tmp], 15000);
  if (ok === null) { try { fs.unlinkSync(tmp); } catch {} return null; }
  try { fs.renameSync(tmp, outFile); return outFile; } catch { return null; }
}

/* ---------------- 转封装 remux（MKV/FLV/TS → mp4，-c copy 无损） ---------------- */

function remuxDir() {
  const dir = path.join(app.getPath('userData'), 'remux');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 缓存键 = md5(路径|大小)，源文件替换（大小变化）即失效
function remuxCacheFile(p, st) {
  const key = crypto.createHash('md5').update(`${p}|${st.size}`).digest('hex');
  return path.join(remuxDir(), `${key}.mp4`);
}

// 会话内状态：ready/unsupported/failed 均落此表；running 持续更新 progress
const remuxState = new Map(); // path → { status, progress, file?, error? }

// 编码门控：视频 h264 且音频（若有）∈ {aac, mp3} 才允许 -c copy 进 mp4
async function probeCodecs(file) {
  const out = await runTool(findFfTools().ffprobe,
    ['-v', 'quiet', '-show_entries', 'stream=codec_name,codec_type', '-of', 'csv=p=0', file], 8000);
  if (!out) return { ok: false, duration: null };
  let video = null, audio = null;
  for (const line of String(out).trim().split(/\r?\n/)) {
    const parts = line.split(',').map((s) => s.trim()); // csv 输出顺序 = codec_name,codec_type
    if (parts[1] === 'video') video = video || parts[0];
    if (parts[1] === 'audio') audio = audio || parts[0];
  }
  const ok = video === 'h264' && (audio == null || ['aac', 'mp3'].includes(audio));
  const duration = await probeDuration(file);
  return { ok, duration };
}

// 解析 ffmpeg -progress 输出的 out_time=HH:MM:SS.ms → 秒
function parseOutTime(line) {
  const m = /^out_time=(\d+):(\d+):(\d+(?:\.\d+)?)$/.exec(line.trim());
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + parseFloat(m[3]);
}

function startRemuxJob(src, outFile, duration) {
  const st = { status: 'running', progress: 0, file: null };
  remuxState.set(src, st);
  const tmp = outFile + '.part.mp4';
  let child;
  try {
    child = spawn(findFfTools().ffmpeg,
      ['-i', src, '-c', 'copy', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', '-loglevel', 'error', '-y', tmp],
      { windowsHide: true });
  } catch {
    st.status = 'failed'; st.error = 'spawn';
    return;
  }
  let buf = '';
  const finish = (ok) => {
    if (st.status !== 'running') return;
    if (ok) {
      try { fs.renameSync(tmp, outFile); st.status = 'ready'; st.file = outFile; st.progress = 1; return; } catch { /* 落入 failed */ }
    }
    try { fs.unlinkSync(tmp); } catch {}
    st.status = 'failed'; st.error = ok ? 'rename' : 'ffmpeg';
  };
  child.stdout.on('data', (d) => {
    buf += d;
    const lines = buf.split(/\r?\n/);
    buf = lines.pop(); // 半行留到下个 chunk
    for (const line of lines) {
      if (!duration) continue;
      const t = parseOutTime(line);
      if (t != null) st.progress = Math.max(st.progress, Math.min(0.99, t / duration));
    }
  });
  child.stderr.on('data', () => {});
  child.on('error', () => finish(false));
  child.on('close', (code) => finish(code === 0));
  // 上限 10 分钟，防机械盘大文件僵尸进程
  setTimeout(() => { if (st.status === 'running') { try { child.kill(); } catch {} finish(false); } }, 10 * 60 * 1000);
}

async function handleRemuxStart(src) {
  const prev = remuxState.get(src);
  if (prev && ['running', 'ready', 'unsupported', 'failed'].includes(prev.status)) return { ...prev };
  const st = statSafe(src);
  if (!st || !st.isFile()) return { status: 'failed', progress: 0, error: 'missing' };
  if (!findFfTools()) return { status: 'no-ffmpeg', progress: 0 };
  const cache = remuxCacheFile(src, st);
  if (fs.existsSync(cache)) {
    const ready = { status: 'ready', progress: 1, file: cache };
    remuxState.set(src, ready);
    return ready;
  }
  const probe = await probeCodecs(src);
  if (!probe.ok) {
    const bad = { status: 'unsupported', progress: 0 };
    remuxState.set(src, bad); // 坏标记：本会话不再重试
    return bad;
  }
  startRemuxJob(src, cache, probe.duration);
  return { ...(remuxState.get(src) || { status: 'running', progress: 0 }) };
}

function dirStats(dir) {
  let files = 0, bytes = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      try { const s = fs.statSync(path.join(dir, f)); if (s.isFile()) { files++; bytes += s.size; } } catch {}
    }
  } catch {}
  return { files, bytes };
}

/* ---------------- IPC ---------------- */

function registerIpc() {
  ipcMain.handle('pick-folders', async () => {
    const r = await dialog.showOpenDialog(mainWindow, { title: '选择学习目录（可多选）', properties: ['openDirectory', 'multiSelections'] });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('pick-files', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择视频 / 讲义文件（可多选）',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: '视频与文档', extensions: [...core.VIDEO_EXTENSIONS, ...core.DOC_EXTENSIONS] },
      ],
    });
    return r.canceled ? [] : r.filePaths;
  });

  ipcMain.handle('scan-roots', (_e, roots) => scanAll(roots));
  ipcMain.handle('scan-course', (_e, dir) => scanCourse(dir));
  ipcMain.handle('open-user-data', () => shell.openPath(app.getPath('userData')));

  ipcMain.handle('get-store', () => store);
  ipcMain.handle('update-store', (_e, patch) => {
    if (patch.videos) store.videos = patch.videos;
    if (patch.settings) store.settings = { ...store.settings, ...patch.settings };
    if (patch.roots) store.roots = patch.roots;
    if (patch.customCourses) store.customCourses = patch.customCourses;
    if (patch.docsByCourse) store.docsByCourse = patch.docsByCourse;
    if (patch.docsIgnored) store.docsIgnored = patch.docsIgnored;
    if (patch.docBinds) store.docBinds = patch.docBinds;
    if (patch.stats) store.stats = patch.stats;
    if (patch.ai) store.ai = { ...STORE_DEFAULT.ai, ...patch.ai };
    saveStoreSoon();
    return true;
  });

  // 分集元信息：{ path, thumb, duration, durationHint } → { thumbPath, duration }
  // thumb=需要缩略图（磁盘缓存命中直接返回）；duration=需要 ffprobe 补时长（已知时长可传 durationHint 跳过探测）
  ipcMain.handle('episode-meta', async (_e, arg) => {
    const { path: file, thumb = false, duration: wantDur = false, durationHint } = arg || {};
    const result = { thumbPath: null, duration: null };
    const st = statSafe(file);
    if (!st || !st.isFile()) return result;
    const cache = thumbCacheFile(file, st);
    if (fs.existsSync(cache)) result.thumbPath = cache;
    if (!findFfTools()) return result;
    if (wantDur || (thumb && !result.thumbPath)) {
      let dur = Number(durationHint) > 0 ? Number(durationHint) : null;
      if (dur == null && (wantDur || thumb)) dur = await runQueued(() => probeDuration(file));
      result.duration = dur;
    }
    if (thumb && !result.thumbPath) {
      const out = await runQueued(() => genThumb(file, cache, result.duration));
      if (out) result.thumbPath = out;
    }
    return result;
  });

  // 转封装：点击非 playable 分集时启动；返回 {status: ready|running|unsupported|failed|no-ffmpeg, progress, file?}
  ipcMain.handle('remux-start', (_e, arg) => handleRemuxStart(arg && arg.path));
  ipcMain.handle('remux-status', (_e, arg) => {
    const s = remuxState.get(arg && arg.path);
    // 磁盘缓存可能被清理，ready 状态需复核文件仍在
    if (s && s.status === 'ready' && s.file && !fs.existsSync(s.file)) {
      remuxState.delete(arg.path);
      return { status: 'failed', progress: 0, error: 'cache-cleared' };
    }
    return s ? { ...s } : { status: 'unknown', progress: 0 };
  });
  // 批量查询哪些分集已有转封装缓存（列表行加 ⚡ 图标）
  ipcMain.handle('remux-check', (_e, arg) => {
    const ready = [];
    for (const p of (arg && arg.paths) || []) {
      const st = statSafe(p);
      if (!st) continue;
      if (fs.existsSync(remuxCacheFile(p, st))) ready.push(p);
    }
    return ready;
  });

  // 缓存治理：占用统计 + 一键清理
  ipcMain.handle('cache-stats', () => ({
    thumbnails: dirStats(path.join(app.getPath('userData'), 'thumbnails')),
    remux: dirStats(path.join(app.getPath('userData'), 'remux')),
  }));
  ipcMain.handle('cache-clear', (_e, arg) => {
    const which = arg && arg.which;
    const dir = which === 'remux' ? path.join(app.getPath('userData'), 'remux')
      : which === 'thumbnails' ? path.join(app.getPath('userData'), 'thumbnails') : null;
    if (!dir) return false;
    try {
      for (const f of fs.readdirSync(dir)) { try { fs.unlinkSync(path.join(dir, f)); } catch {} }
      if (which === 'remux') for (const [k, v] of remuxState) if (v.status === 'ready') remuxState.delete(k);
      return true;
    } catch { return false; }
  });

  ipcMain.handle('reveal', (_e, p) => shell.showItemInFolder(p));
  ipcMain.handle('open-path', (_e, p) => shell.openPath(p));

  // 拖拽进来的 File 对象 → 真实路径（Electron 32+ 不再提供 file.path）
  ipcMain.handle('drop-paths', (_e, files) => {
    return (files || []).map((f) => {
      try { return webUtils.getPathForFile(f); } catch { return null; }
    });
  });

  // AI 侧边栏（M7）：网络/截帧/历史全在主进程，见 ai-bridge.js
  registerAiIpc({
    getWin: () => mainWindow,
    getStore: () => store,
    saveStore: saveStoreSoon,
    ff: { findFfTools, remuxState },
  });
}

/* ---------------- 启动 ---------------- */

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      await loadCore();
    } catch (err) {
      console.error('[core] 加载失败', err);
      dialog.showErrorBox('启动失败', `核心模块加载失败：\n${err && err.message ? err.message : err}`);
      app.quit();
      return;
    }
    store = loadStore();
    registerIpc();
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  });

  app.on('window-all-closed', () => app.quit());
}
