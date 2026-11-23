#!/usr/bin/env node
/**
 * 冒烟测试 + 视觉/DOM 基线（P0 建立，P2 扩展）
 *
 * 用独立 userData 启动应用，加载 ffmpeg 生成的媒体夹具，通过 CDP 驱动真实点击：
 *   1. 扫描与树结构
 *   2. 播放 / 进度持久化 / 续播
 *   3. 全局搜索跳转
 *   4. AI 侧栏开合
 *   5. 导入弹窗 / 看板
 *   P2：进度更新 ≤2 行 DOM、列表仅 1 个 click 委托、讲义浮层、悬停预览、
 *      设置弹窗、?legacy=1 双轨启动与播放。
 * 并输出 8 张基线截图（4 视图 × 2 主题）与 DOM 快照。
 *
 * 用法：
 *   node scripts/smoke.mjs                     # 断言 + 与基线快照比对（有基线时）
 *   node scripts/smoke.mjs --write-baseline    # 重新生成基线截图与 DOM 快照
 *   node scripts/smoke.mjs --keep              # 保留临时 userData 便于排查
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertSingleEntry, hashOfEntryName } from './build-lib.mjs';
import { checkVendor } from './sync-vendor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const BASELINE_DIR = path.join(ROOT, 'docs', 'refactor', 'baseline');
const BASELINE_SNAPSHOT = path.join(BASELINE_DIR, 'dom-snapshot.json');
const PACKAGED_DIR = path.join(ROOT, 'dist', 'win-unpacked');

const argv = process.argv.slice(2);
const WRITE_BASELINE = argv.includes('--write-baseline');
const KEEP = argv.includes('--keep');
const PACKAGED = argv.includes('--packaged');
if (PACKAGED && WRITE_BASELINE) {
  console.error('--packaged 与 --write-baseline 不能同时使用（打包版不写视觉基线）');
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 断言 ---------------- */

const failures = [];
const passes = [];
function check(cond, label, detail = '') {
  if (cond) {
    passes.push(label);
    console.log(`  ✓ ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ''}`);
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/* ---------------- 构建产物（P4） ---------------- */

function checkBuildArtifacts() {
  const indexPath = path.join(ROOT, 'renderer', 'index.html');
  const html = fs.readFileSync(indexPath, 'utf8');
  let entry = null;
  try {
    entry = assertSingleEntry(html);
    check(true, 'index.html 现代入口 = 1 个哈希脚本', entry);
  } catch (err) {
    check(false, 'index.html 现代入口 = 1 个哈希脚本', err.message);
    return;
  }
  check(!/src="[^"]*\?v=/.test(html), 'index.html 无 ?v=N 脚本版本号');
  const entryFile = path.join(ROOT, 'renderer', entry);
  check(fs.existsSync(entryFile), '哈希入口文件存在', entry);

  const hash = hashOfEntryName(path.basename(entry));
  const infoPath = path.join(ROOT, 'renderer', 'dist', 'build-info.json');
  let info = null;
  try {
    info = JSON.parse(fs.readFileSync(infoPath, 'utf8'));
  } catch {
    /* 下面断言会给出失败 */
  }
  check(
    !!info && info.entry === entry && String(info.sha256).startsWith(hash) && info.bytes === fs.statSync(entryFile).size,
    'build-info.json 与入口 hash / 字节一致',
    JSON.stringify(info),
  );

  const diffs = checkVendor();
  check(diffs.length === 0, 'vendor 与 manifest / node_modules 一致', diffs.slice(0, 3).join(' | '));

  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'renderer', 'vendor', 'manifest.json'), 'utf8'));
  } catch {
    /* 上面 checkVendor 已覆盖缺失 */
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const versions = manifest
    ? Object.entries(manifest.libraries).map(([name, lib]) => `${name}@${lib.version}`).join(' / ')
    : '';
  check(
    !!manifest && Object.entries(manifest.libraries).every(([name, lib]) => pkg.devDependencies[name] === lib.version),
    'vendor manifest 版本 = package.json 固定版本',
    versions,
  );
}

/* ---------------- 打包产物 / asar（P4） ---------------- */

function packagedExePath() {
  if (process.platform !== 'win32' || !fs.existsSync(PACKAGED_DIR)) return null;
  const preferred = path.join(PACKAGED_DIR, '学习播放器.exe');
  if (fs.existsSync(preferred)) return preferred;
  const fallback = fs
    .readdirSync(PACKAGED_DIR)
    .find((name) => name.endsWith('.exe') && !/^(elevate|uninstall)/i.test(name));
  return fallback ? path.join(PACKAGED_DIR, fallback) : null;
}

/** 读 asar 头（JSON 目录表）；数据区从 8 + headerSize 开始 */
function loadAsar(asarPath) {
  const fd = fs.openSync(asarPath, 'r');
  try {
    // 布局：[uint32 sizePickle][uint32 headerSize][uint32 pickleSize][uint32 jsonSize][json...]
    const head = Buffer.alloc(8);
    fs.readSync(fd, head, 0, 8, 0);
    const headerSize = head.readUInt32LE(4);
    const headerBuf = Buffer.alloc(headerSize);
    fs.readSync(fd, headerBuf, 0, headerSize, 8);
    const jsonSize = headerBuf.readUInt32LE(4);
    const header = JSON.parse(headerBuf.slice(8, 8 + jsonSize).toString('utf8'));
    return { header, dataOffset: 8 + headerSize };
  } finally {
    fs.closeSync(fd);
  }
}

function walkAsar(header, prefix = '', out = []) {
  for (const [name, node] of Object.entries(header.files || {})) {
    const relative = prefix ? `${prefix}/${name}` : name;
    if (node && node.files) walkAsar(node, relative, out);
    else if (node) out.push({ path: relative, size: Number(node.size) || 0, offset: Number(node.offset) || 0 });
  }
  return out;
}

function readAsarFile(asarPath, relative, loaded = null) {
  const { header, dataOffset } = loaded || loadAsar(asarPath);
  let node = header;
  for (const part of String(relative).split('/')) {
    node = node && node.files ? node.files[part] : null;
    if (!node) return null;
  }
  if (node.files || node.offset == null || node.size == null) return null;
  const size = Number(node.size) || 0;
  const fd = fs.openSync(asarPath, 'r');
  try {
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, dataOffset + Number(node.offset));
    return buf.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function checkPackagedArtifacts() {
  const exe = packagedExePath();
  check(!!exe, '打包产物 exe 存在', exe || PACKAGED_DIR);
  const asarPath = path.join(PACKAGED_DIR, 'resources', 'app.asar');
  check(fs.existsSync(asarPath), '打包产物 asar 存在', asarPath);
  if (!fs.existsSync(asarPath)) return;

  const loaded = loadAsar(asarPath);
  const files = walkAsar(loaded.header);
  const paths = new Set(files.map((f) => f.path));
  const required = [
    'main.js',
    'preload.js',
    'platform.js',
    'ai-bridge.js',
    'package.json',
    'renderer/index.html',
    'renderer/style.css',
    'renderer/renderer.js',
    'renderer/ai.js',
    'renderer/lib-boot.js',
    'renderer/vendor/katex.min.css',
    'renderer/vendor/fonts/KaTeX_Main-Regular.woff2',
    'renderer/dist/build-info.json',
  ];
  const missing = required.filter((p) => !paths.has(p));
  check(missing.length === 0, 'asar 含全部关键文件', missing.join(', '));

  const html = readAsarFile(asarPath, 'renderer/index.html', loaded) || '';
  let entry = null;
  try {
    entry = assertSingleEntry(html);
    check(true, 'asar 内 index.html = 1 个哈希入口', entry);
  } catch (err) {
    check(false, 'asar 内 index.html = 1 个哈希入口', err.message);
  }
  if (entry) check(paths.has(`renderer/${entry}`), 'asar 含哈希入口文件', entry);

  let info = null;
  try {
    info = JSON.parse(readAsarFile(asarPath, 'renderer/dist/build-info.json', loaded) || 'null');
  } catch {
    /* 下面断言 */
  }
  check(
    !!info && !!entry && info.entry === entry && paths.has(`renderer/${info.entry}`),
    'asar 内 build-info 与入口一致',
    JSON.stringify(info),
  );

  const bundles = files.filter((f) => /^renderer\/dist\/app\.[0-9a-f]{10}\.js$/.test(f.path));
  check(bundles.length === 1, 'asar 内只有 1 份哈希 bundle', String(bundles.length));
  check(
    !paths.has('mac/README.md') &&
      !paths.has('node_modules/electron/package.json') &&
      !paths.has('.backup/v0.4.4-20261022-225826/learn.json.snapshot'),
    'asar 不含 mac / node_modules / .backup',
  );
  check(
    (readAsarFile(asarPath, 'renderer/vendor/katex.min.css', loaded) || '').includes('KaTeX_Main'),
    'asar 内 katex CSS 完整',
  );
}

/* ---------------- 夹具 ---------------- */

function ensureFixture() {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fixtures', 'gen-fixture.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

/* ---------------- 临时 profile ---------------- */

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), `vds-smoke-${stamp.slice(0, 19)}-`));
const SHOT_DIR = PACKAGED ? path.join(runDir, 'shots') : BASELINE_DIR;
if (PACKAGED) fs.mkdirSync(SHOT_DIR, { recursive: true });

function makeProfile(name, store) {
  const dir = path.join(runDir, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'learn.json'), JSON.stringify(store, null, 2), 'utf8');
  return dir;
}

function readStore(profile) {
  try {
    return JSON.parse(fs.readFileSync(path.join(profile, 'learn.json'), 'utf8'));
  } catch {
    return null;
  }
}

/* ---------------- CDP ---------------- */

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.consoleErrors = [];
    this.cspViolations = [];
    this.logErrors = [];
  }

  async open() {
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params?.exceptionDetails;
        this.exceptions.push(d?.exception?.description || d?.text || 'unknown exception');
      }
      if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description).join(' '));
      }
      if (msg.method === 'Log.entryAdded') {
        const entry = msg.params?.entry || {};
        const text = String(entry.text || '');
        if (/Content Security Policy|Refused to (load|execute|apply|connect)/i.test(text)) this.cspViolations.push(text);
        if (entry.level === 'error') this.logErrors.push(text);
      }
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
  }

  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression, { includeCommandLineAPI = true } = {}) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails;
      throw new Error(d.exception?.description || d.text || 'evaluate failed');
    }
    return r.result.value;
  }

  async waitFor(expression, { timeout = 8000, label = expression } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.eval(`(() => { try { return !!(${expression}); } catch (e) { return false; } })()`).catch(() => false);
      if (ok) return true;
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }

  async screenshot(file) {
    // 截图前把鼠标移到左上角，避免空状态按钮 hover 造成偶发像素差
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 });
    await sleep(60);
    const target = PACKAGED ? path.join(SHOT_DIR, path.basename(file)) : file;
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(target, Buffer.from(r.data, 'base64'));
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/* ---------------- 启动 / 关闭 ---------------- */

function launch(profile, port, tag) {
  const env = { ...process.env, VDS_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const logPath = path.join(profile, `electron-${tag}.log`);
  const fd = fs.openSync(logPath, 'w');
  let command = ELECTRON;
  let args = ['.', `--remote-debugging-port=${port}`];
  let cwd = ROOT;
  if (PACKAGED) {
    const exe = packagedExePath();
    if (!exe) throw new Error(`未找到打包产物，先运行 npm run dist:dir（期望 ${PACKAGED_DIR}）`);
    command = exe;
    args = [`--remote-debugging-port=${port}`];
    cwd = path.dirname(exe);
  }
  const child = spawn(command, args, {
    cwd,
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: false,
  });
  return { child, logPath };
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch {
    /* 已退出 */
  }
}

async function connect(port, logPath) {
  const deadline = Date.now() + 30000;
  let target = null;
  while (Date.now() < deadline) {
    try {
      const list = await new Promise((resolve, reject) => {
        http
          .get(`http://127.0.0.1:${port}/json`, (res) => {
            let s = '';
            res.on('data', (d) => (s += d));
            res.on('end', () => {
              try {
                resolve(JSON.parse(s));
              } catch (e) {
                reject(e);
              }
            });
          })
          .on('error', reject);
      });
      target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) break;
    } catch {
      /* 尚未就绪 */
    }
    await sleep(250);
  }
  if (!target) {
    const tail = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-2000) : '';
    throw new Error(`CDP 未就绪，Electron 日志：\n${tail}`);
  }
  const cdp = new Cdp(target.webSocketDebuggerUrl);
  await cdp.open();
  return cdp;
}

async function bootApp(profile, port, tag, { search = '' } = {}) {
  const { child, logPath } = launch(profile, port, tag);
  let cdp = null;
  try {
    cdp = await connect(port, logPath);
    if (search) {
      const href = await cdp.eval('location.href');
      await cdp.send('Page.navigate', { url: href.split('?')[0] + search });
      await sleep(400);
    }
    const mode = search.includes('legacy=1') ? 'legacy' : 'next';
    if (mode === 'legacy') {
      await cdp.waitFor(
        `document.documentElement.dataset.appMode === 'legacy' && typeof state !== 'undefined' && state.store && state.subjects`,
        { timeout: 20000, label: '旧界面启动完成' },
      );
    } else {
      await cdp.waitFor('window.__VDS_READY === true', { timeout: 20000, label: '新壳启动完成' });
      // 冒烟专用别名：只读显式测试钩子，不向应用注入兼容全局
      await cdp.eval(`window.__T = {
        get: () => window.__VDS_STORE.get(),
        actions: window.__VDS_ACTIONS,
        video: () => window.__VDS.getVideo(),
        player: () => window.__VDS.getPlayer(),
      }`);
    }
    await cdp.waitFor(`document.querySelectorAll('.ep-row').length > 0 || !document.getElementById('emptyState').classList.contains('hidden')`, {
      timeout: 15000,
      label: '列表或空状态渲染',
    });
    await sleep(500);
    return { cdp, child, logPath };
  } catch (err) {
    if (cdp) {
      if (cdp.exceptions.length) console.error('[启动失败] 页面异常：\n  ' + cdp.exceptions.slice(0, 5).join('\n  '));
      if (cdp.consoleErrors.length) console.error('[启动失败] console.error：\n  ' + cdp.consoleErrors.slice(0, 5).join('\n  '));
      const state = await cdp.eval(`({ hasLibs: !!window.Core, hasUI: !!window.UI, libsReady: !!window.LibsReady, store: !!(typeof state !== 'undefined' && state.store) })`).catch(() => null);
      if (state) console.error('[启动失败] 状态：' + JSON.stringify(state));
    }
    killTree(child.pid);
    throw err;
  }
}

/* ---------------- 快照 ---------------- */

async function snapshot(cdp, view) {
  return cdp.eval(`(() => {
    const rect = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { w: Math.round(r.width), h: Math.round(r.height), x: Math.round(r.x), y: Math.round(r.y) };
    };
    const main = document.getElementById('main');
    return {
      view: ${JSON.stringify(view)},
      theme: document.body.classList.contains('light') ? 'light' : 'dark',
      documentTitle: document.title,
      topbarButtons: [...document.querySelectorAll('#topbar button')].map((b) => b.textContent.trim()),
      courseTitle: document.getElementById('courseTitle').textContent,
      progressChip: document.getElementById('progressChip').textContent,
      rows: document.querySelectorAll('.ep-row').length,
      rowTitles: [...document.querySelectorAll('.ep-row .title')].map((t) => t.textContent),
      rowButtons: [...document.querySelectorAll('.ep-row .row-btn')].map((b) => b.textContent),
      titleTruncated: [...document.querySelectorAll('.ep-row .title')].filter((t) => t.scrollWidth > t.clientWidth + 1).length,
      emptyText: document.querySelector('.empty-title')?.textContent || null,
      dockVisible: !document.getElementById('dock').classList.contains('hidden'),
      dockTab: main ? main.dataset.dockTab : null,
      dockTabs: [...document.querySelectorAll('#dockTabs [role=tab]')].map((b) => ({ label: b.textContent, selected: b.getAttribute('aria-selected') })),
      aiHead: [...(document.querySelectorAll('#aiPanel .mini-btn') || [])].map((b) => b.textContent.trim()),
      dashTitles: [...document.querySelectorAll('#dashboard .dash-sec-title')].map((e) => e.textContent),
      dashLabels: [...document.querySelectorAll('#dashboard .w-label')].map((e) => e.textContent),
      subjNames: [...document.querySelectorAll('.subj-row .s-name')].map((e) => e.textContent),
      docMatch: (window.__VDS_STORE ? window.__VDS_STORE.get().library.course : null)
        ? window.__VDS_STORE.get().library.course.docs.map((d) => ({ name: d.name, idx: d.episodeIndex })) : [],
      rects: {
        topbar: rect('#topbar'), nav: rect('#sidebar'), list: rect('#episodePanel'),
        player: rect('#playerPanel'), ai: rect('#dock'), main: rect('#main'),
      },
      overflowX: main ? main.scrollWidth > main.clientWidth + 1 : null,
    };
  })()`);
}

async function setTheme(cdp, theme) {
  await cdp.eval(`(() => {
    const isLight = document.body.classList.contains('light');
    if ((${JSON.stringify(theme)} === 'light') !== isLight) document.getElementById('btnTheme').click();
  })()`);
  await cdp.waitFor(`document.body.classList.contains('light') === ${theme === 'light'}`, { label: `主题=${theme}` });
}

async function press(cdp, key) {
  await cdp.eval(`(() => {
    const el = document.activeElement && document.activeElement.id === 'globalSearch'
      ? document.activeElement : document.getElementById('globalSearch');
    el.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true, cancelable: true }));
  })()`);
}

/* ---------------- 真实键盘事件（P3 纯键盘链路） ---------------- */

const VK = { Tab: 9, Enter: 13, Escape: 27, Space: 32, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, KeyF: 70, KeyI: 73, KeyK: 75, KeyM: 77, KeyN: 78, KeyP: 80, Slash: 191 };
const KEY_NAME = { Tab: 'Tab', Enter: 'Enter', Escape: 'Escape', Space: ' ', ArrowLeft: 'ArrowLeft', ArrowUp: 'ArrowUp', ArrowRight: 'ArrowRight', ArrowDown: 'ArrowDown' };

async function sendKey(cdp, key, { code, modifiers = 0, text } = {}) {
  const keyName = KEY_NAME[key] || key;
  const codeName = code || (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key);
  const vk = VK[codeName] || VK[keyName] || 0;
  const base = { key: keyName, code: codeName, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  // Enter 的默认激活需要 rawKeyDown + char；普通 keyDown 只到 JS 监听器
  if (keyName === 'Enter') {
    await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', ...base });
    await cdp.send('Input.dispatchKeyEvent', { type: 'char', ...base, text: '\r', unmodifiedText: '\r' });
  } else {
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(text ? { text } : {}) });
  }
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  await sleep(60);
}

async function activeInfo(cdp) {
  return cdp.eval(`(() => { const a=document.activeElement; return { id:a.id, tag:a.tagName, cls:a.className||'', course:!!(a.closest&&a.closest('.course-item')), row:!!(a.closest&&a.closest('.ep-row')) }; })()`);
}

/* ---------------- 主流程 ---------------- */

async function runLibrary(fixture) {
  const profile = makeProfile('library', {
    roots: [fixture.root],
    settings: {
      theme: 'dark',
      rate: 1,
      volume: 0.9,
      autoNext: true,
      lastCoursePath: fixture.courses['高数'],
      lastEpisodePath: '',
      panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
    },
  });
  const { cdp, child } = await bootApp(profile, 9351, 'library');
  const views = {};

  try {
    // ---- 1. 结构与扫描 ----
    console.log('\n[1/5] 扫描与结构');
    const entry = await cdp.eval(`(() => {
      const scripts = [...document.querySelectorAll('script[src]')].map((s) => s.getAttribute('src'));
      return {
        scripts,
        href: location.href,
        libsReady: 'LibsReady' in window,
        coreGlobal: 'Core' in window,
        uiGlobal: 'UI' in window,
        vendor: {
          marked: typeof window.marked?.parse === 'function',
          purifier: typeof window.DOMPurify?.sanitize === 'function',
          katex: typeof window.katex?.renderToString === 'function',
        },
      };
    })()`);
    check(
      entry.scripts.length === 1 && /^dist\/app\.[0-9a-f]{10}\.js$/.test(entry.scripts[0]),
      '现代入口只有 1 个内容哈希脚本',
      JSON.stringify(entry.scripts),
    );
    check(
      !entry.libsReady && !entry.coreGlobal && !entry.uiGlobal,
      '现代路径不加载 lib-boot（无 LibsReady/Core/UI 全局）',
      JSON.stringify({ libsReady: entry.libsReady, core: entry.coreGlobal, ui: entry.uiGlobal }),
    );
    check(
      entry.vendor.marked && entry.vendor.purifier && entry.vendor.katex,
      'vendor 全局随 bundle 前导就绪',
      JSON.stringify(entry.vendor),
    );
    check(!/[?&]v=/.test(entry.href), '现代入口无 ?v=N 版本号', entry.href);
    const tree = await cdp.eval(`(() => {
      const s = window.__T.get();
      return {
        subjects: s.library.subjects.map((x) => ({ name: x.name, courses: x.courses.map((c) => ({ name: c.name, eps: c.episodes.length, docs: c.docs.length })) })),
        current: s.library.course && s.library.course.name,
        apiKeys: Object.keys(window.api).length,
        subjectNode: document.querySelectorAll('.subject').length,
        courseNodes: document.querySelectorAll('.course-item').length,
        mode: document.documentElement.dataset.appMode,
      };
    })()`);
    check(tree.mode === 'next', '默认路径使用新壳', String(tree.mode));
    check(tree.subjects.length === 1 && tree.subjects[0].name === '数学', '科目扫描 = 数学', JSON.stringify(tree.subjects.map((s) => s.name)));
    const gaoshu = tree.subjects[0].courses.find((c) => c.name === '高数');
    check(!!gaoshu && gaoshu.eps === 3, '高数分集 = 3', String(gaoshu && gaoshu.eps));
    check(!!gaoshu && gaoshu.docs === 2, '高数讲义 = 2', String(gaoshu && gaoshu.docs));
    check(tree.current === '高数', '恢复上次课程 = 高数', String(tree.current));
    check(tree.apiKeys === 26, 'preload 暴露 26 个方法', String(tree.apiKeys));
    check(tree.courseNodes === 2, '左侧课程节点 = 2', String(tree.courseNodes));

    // ---- 2. 播放 / 持久化 / 续播 ----
    console.log('\n[2/5] 播放 / 进度 / 续播');
    const firstPath = await cdp.eval(`window.__T.get().library.course.episodes[0].path`);
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('window.__T.get().playback.index === 0 && window.__T.video().duration > 0', { label: '首集起播' });
    check((await cdp.eval('window.__T.video().duration')) > 35, '首集时长 ≈40s', String(await cdp.eval('window.__T.video().duration')));

    await cdp.eval('window.__T.video().currentTime = 12; window.__T.video().pause()');
    await sleep(900);
    const store1 = readStore(profile);
    const rec1 = store1?.videos?.[firstPath];
    check(!!rec1 && rec1.position > 10.5 && rec1.position < 13.5, '暂停后写入进度 ≈12s', JSON.stringify(rec1 && rec1.position));

    // 切到第 2 集再切回，验证续播（阈值 >10s 且未接近结尾）
    await cdp.eval(`document.querySelectorAll('.ep-row')[1].click()`);
    await cdp.waitFor('window.__T.get().playback.index === 1', { label: '切到第 2 集' });
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('window.__T.get().playback.index === 0 && window.__T.video().currentTime > 11', { timeout: 8000, label: '续播回到 ≈12s' });
    check(true, '续播从上次位置继续');
    await cdp.eval('window.__T.video().pause()');
    await sleep(400);
    await cdp.eval('window.__T.video().currentTime = 3; window.__T.video().pause()');
    await sleep(700);

    // ---- 3. 截图：course / ai / dashboard × 2 主题 ----
    console.log('\n[3/5] 截图');
    await setTheme(cdp, 'dark');
    views['course-dark'] = await snapshot(cdp, 'course-dark');
    await cdp.screenshot(path.join(BASELINE_DIR, 'course-dark.png'));

    await setTheme(cdp, 'light');
    views['course-light'] = await snapshot(cdp, 'course-light');
    await cdp.screenshot(path.join(BASELINE_DIR, 'course-light.png'));

    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'ai'`, { label: 'AI 页签打开' });
    check((await cdp.eval(`document.getElementById('aiCtxChip').textContent`)).includes('开'), 'AI 上下文开关默认开');
    const aiWide = await cdp.eval(`(() => { const m=document.getElementById('main'); const p=document.getElementById('playerPanel').getBoundingClientRect(); return { main:Math.round(m.clientWidth), player:Math.round(p.width), overflow:m.scrollWidth>m.clientWidth+1 }; })()`);
    check(aiWide.player >= 420 && !aiWide.overflow, '1344 + AI：播放器 ≥420px 且无横向溢出', JSON.stringify(aiWide));
    views['ai-dark'] = await snapshot(cdp, 'ai-dark');
    await cdp.screenshot(path.join(BASELINE_DIR, 'ai-dark.png'));

    await setTheme(cdp, 'light');
    views['ai-light'] = await snapshot(cdp, 'ai-light');
    await cdp.screenshot(path.join(BASELINE_DIR, 'ai-light.png'));
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, { label: 'AI 页签关闭' });

    // 看板缩略图走 ffmpeg 异步队列；先预热当前分集，避免截图抢在生成完成前（不改产品逻辑）
    const contPath = await cdp.eval(`window.__T.get().library.course.episodes[0].path`);
    await cdp.eval(`window.__VDS.api.episodeMeta({ path: ${JSON.stringify(contPath)}, thumb: true, duration: true })`);
    await cdp.eval(`document.getElementById('btnHome').click()`);
    await cdp.waitFor(`!document.getElementById('dashboard').classList.contains('hidden')`, { label: '看板打开' });
    await cdp
      .waitFor(
        `(() => { const i = document.getElementById('contThumb'); return !!i && !i.classList.contains('hidden') && i.complete; })()`,
        { timeout: 6000, label: '看板缩略图就绪' },
      )
      .catch(() => {});
    await sleep(200);
    const thumbReady = await cdp.eval(`(() => {
      const i = document.getElementById('contThumb');
      const n = document.getElementById('contNoImg');
      return !!i && i.complete && i.naturalWidth > 0 && !i.classList.contains('hidden') && n.classList.contains('hidden');
    })()`);
    check(thumbReady, '看板缩略图已生成并显示（截图确定性）');
    views['dashboard-dark'] = await snapshot(cdp, 'dashboard-dark');
    await cdp.screenshot(path.join(BASELINE_DIR, 'dashboard-dark.png'));
    await setTheme(cdp, 'light');
    views['dashboard-light'] = await snapshot(cdp, 'dashboard-light');
    await cdp.screenshot(path.join(BASELINE_DIR, 'dashboard-light.png'));
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnHome').click()`);
    await cdp.waitFor(`document.getElementById('dashboard').classList.contains('hidden')`, { label: '返回播放视图' });

    // ---- P2：增量渲染 / 事件委托 / 浮层 ----
    console.log('\n[P2] 增量渲染 / 事件委托 / 浮层');
    await sleep(1200); // 等可视区时长补全稳定，避免干扰 MutationObserver
    const mutation = await cdp.eval(`(async () => {
      window.__rowMutated = new Set();
      window.__rowObserver?.disconnect();
      window.__rowObserver = new MutationObserver((records) => {
        for (const record of records) {
          const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
          const row = node && node.closest ? node.closest('.ep-row') : null;
          if (row) window.__rowMutated.add(row.dataset.path);
        }
      });
      window.__rowObserver.observe(document.getElementById('episodeList'), {
        subtree: true, childList: true, characterData: true, attributes: true,
      });
      const v = window.__T.video();
      v.currentTime = 17;
      v.dispatchEvent(new Event('pause'));
      await new Promise((r) => setTimeout(r, 500));
      window.__rowObserver.disconnect();
      return { rows: window.__rowMutated.size, pct: document.querySelector('.ep-row.active .pct')?.textContent || '' };
    })()`);
    check(mutation.rows <= 2, '进度更新只改 ≤2 行 DOM', `rows=${mutation.rows} pct=${mutation.pct}`);
    const listeners = await cdp.eval(`(() => {
      if (typeof getEventListeners !== 'function') return null;
      const list = document.getElementById('episodeList');
      const row = document.querySelector('.ep-row');
      const count = (el) => Object.values(getEventListeners(el)).reduce((n, arr) => n + arr.length, 0);
      return {
        listTotal: count(list),
        listClick: (getEventListeners(list).click || []).length,
        listKeydown: (getEventListeners(list).keydown || []).length,
        rowTotal: count(row),
      };
    })()`);
    check(
      !!listeners && listeners.listClick === 1 && listeners.rowTotal === 0,
      '分集列表 = 1 个容器 click 委托，行内 0 监听',
      JSON.stringify(listeners),
    );

    // 讲义页签开合
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'docs'`, { label: '讲义页签打开' });
    const docCount = await cdp.eval(`document.querySelectorAll('#docsList .doc-item').length`);
    check(docCount === 2, '讲义页签列出 2 份资料', String(docCount));
    // 关联：手动绑定优先于自动匹配
    const bindPath = await cdp.eval(`(() => {
      const btn = document.querySelector('#docsList .doc-item .d-btn[data-act="bind"]');
      if (!btn) return null;
      const path = btn.dataset.docPath;
      btn.click();
      return path;
    })()`);
    await sleep(200);
    check(!!bindPath && (await cdp.eval(`window.__T.get().library.docBinds[${JSON.stringify(bindPath)}]`)) === 0, '讲义可关联到当前分集');
    // 刷新匹配不丢手动绑定
    await cdp.eval(`document.getElementById('docRefresh').click()`);
    await sleep(250);
    check((await cdp.eval(`document.querySelectorAll('#docsList .doc-item').length`)) === 2, '讲义刷新匹配仍列出 2 份');
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, { label: '讲义页签关闭' });

    // 悬停预览（先验可见性，缩略图异步生成不影响判断）
    await cdp.eval(`document.querySelector('.ep-row').dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))`);
    await sleep(700);
    const hover = await cdp.eval(`({
      visible: !document.getElementById('hoverPreview').classList.contains('hidden'),
      name: document.getElementById('hpName').textContent,
    })`);
    check(hover.visible && hover.name.length > 0, '分集悬停预览可见', JSON.stringify(hover));
    await cdp.eval(`document.getElementById('episodePanel').dispatchEvent(new MouseEvent('mouseleave'))`);

    // 设置弹窗：原生 <dialog>、role/aria、Esc 焦点归还
    await cdp.eval(`document.getElementById('btnSettings').click()`);
    await cdp.waitFor(`document.getElementById('settingsModal').open === true`, { label: '设置弹窗打开' });
    const settings = await cdp.eval(`(() => {
      const d = document.getElementById('settingsModal');
      return {
        roots: document.querySelectorAll('#rootList .root-item').length,
        autoNext: document.getElementById('setAutoNext').checked,
        tag: d.tagName,
        role: d.getAttribute('role'),
        modal: d.getAttribute('aria-modal'),
        labelledby: d.getAttribute('aria-labelledby'),
        focusInside: d.contains(document.activeElement),
      };
    })()`);
    check(settings.roots === 1 && settings.autoNext === true, '设置弹窗数据正确', JSON.stringify(settings));
    check(settings.tag === 'DIALOG' && settings.role === 'dialog' && settings.modal === 'true' && !!settings.labelledby, '设置弹窗使用原生 <dialog> + aria', JSON.stringify(settings));
    check(settings.focusInside === true, '设置弹窗打开时焦点在弹窗内', String(settings.focusInside));
    await cdp.eval(`(() => { const el=document.getElementById('aiBaseUrl'); el.value='http://127.0.0.1:1/v1'; el.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    check((await cdp.eval(`window.__T.get().ai.config.baseUrl`)) === 'http://127.0.0.1:1/v1', '设置页 AI 配置写入 store.ai');
    await cdp.eval(`document.getElementById('setClose').click()`);
    await cdp.waitFor(`document.getElementById('settingsModal').open === false`, { label: '设置弹窗关闭' });
    const focusBack = await cdp.eval(`document.activeElement && document.activeElement.id`);
    check(focusBack === 'btnSettings', '设置弹窗关闭后焦点回到触发按钮', String(focusBack));

    // ---- 4. 搜索 ----
    console.log('\n[4/5] 搜索 / 导入弹窗 / 看板数据');
    await cdp.eval(`(() => {
      const el = document.getElementById('globalSearch');
      el.focus();
      el.value = '极限';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    })()`);
    await cdp.waitFor(`document.querySelectorAll('#searchDrop .gs-item').length > 0`, { label: '搜索出结果' });
    const hits = await cdp.eval(`document.querySelectorAll('#searchDrop .gs-item').length`);
    check(hits >= 1, '搜索「极限」有结果', String(hits));
    await press(cdp, 'Enter');
    await cdp.waitFor('window.__T.get().playback.index === 1', { label: '搜索回车跳到第 2 集' });
    check(true, '搜索跳转并起播');

    // 导入弹窗（跳过系统文件对话框，直接走应用内弹窗路径）
    await cdp.eval(`window.__T.actions.openImport({ type: 'folder', dirs: [${JSON.stringify(fixture.courses['高数'])}] })`);
    await cdp.waitFor(`document.getElementById('importModal').open === true`, { label: '导入弹窗打开' });
    const importTitle = await cdp.eval(`document.getElementById('importTitle').textContent`);
    check(importTitle.includes('导入'), '导入弹窗标题正确', importTitle);
    await cdp.eval(`document.getElementById('impCancel').click()`);
    await cdp.waitFor(`document.getElementById('importModal').open === false`, { label: '导入弹窗关闭' });

    // 看板数据
    await cdp.eval(`document.getElementById('btnHome').click()`);
    await cdp.waitFor(`document.querySelectorAll('.subj-row').length === 1`, { label: '看板科目行' });
    const subj = await cdp.eval(`document.querySelector('.subj-row .s-name').textContent`);
    check(subj === '数学', '看板科目 = 数学', subj);
    await cdp.eval(`document.getElementById('btnHome').click()`);

    // 共享库与 UI 基础设施（P4：随 bundle 提供，不再挂 window.Core / UI）
    const libs = await cdp.eval(`(() => {
      const core = window.__VDS && window.__VDS.core;
      const ui = window.__VDS && window.__VDS.ui;
      return {
        core: !!core,
        ui: !!ui,
        api: !!ui && ['createToast', 'createDialog', 'createShortcuts', 'createSplitter', 'h', 'renderRich'].every((k) => typeof ui[k] === 'function'),
        appLibs: !!core && typeof core.progressState === 'function' && typeof core.matchDocs === 'function',
        // 不用 typeof：CDP 的 includeCommandLineAPI 会注入 $，下面用无 API 的 evaluate 复核
        legacyGlobals: ['state', '$', 'esc', 'fmtTime', 'showToast', 'toggleAI']
          .filter((k) => Object.prototype.hasOwnProperty.call(window, k)),
      };
    })()`);
    const noGlobals = await cdp.eval(`['state', '$', 'esc', 'fmtTime', 'showToast', 'toggleAI', 'LibsReady']
      .filter((k) => Object.prototype.hasOwnProperty.call(window, k))`, { includeCommandLineAPI: false });
    check(libs.core && libs.ui, 'core / ui 随 bundle 可用（不再注入 window）');
    check(libs.api, 'ui 基础模块导出完整');
    check(libs.appLibs, 'core 纯函数可用');
    check(noGlobals.length === 0, '新路径无 ai.js 六个兼容全局 / 无 LibsReady', noGlobals.join(','));

    const uiCheck = await cdp.eval(`(() => {
      const el = window.__VDS.ui.h('div', { class: 'ui-probe', dataset: { k: '1' } }, ['测试']);
      document.body.appendChild(el);
      const ok = el.className === 'ui-probe' && el.dataset.k === '1' && el.textContent === '测试';
      el.remove();
      return ok;
    })()`);
    check(uiCheck, 'UI.h() 建节点正确');
    await cdp.eval(`window.__VDS.toast.show('smoke-toast')`);
    const toastOk = await cdp.eval(`(() => {
      const t = document.getElementById('toast');
      return t.textContent === 'smoke-toast' && !t.classList.contains('hidden');
    })()`);
    check(toastOk, 'toast 走 ui/toast 实例');
    const toastLive = await cdp.eval(`(() => {
      const t = document.getElementById('toast');
      return { role: t.getAttribute('role'), live: t.getAttribute('aria-live'), atomic: t.getAttribute('aria-atomic') };
    })()`);
    check(toastLive.role === 'status' && toastLive.live === 'polite', 'Toast 有 role=status / aria-live=polite', JSON.stringify(toastLive));

    // 讲义自动匹配（P1 起：扫描课程也应匹配成功）
    const docMatch = await cdp.eval(`(window.__T.get().library.course.docs || []).map((d) => ({ name: d.name, idx: d.episodeIndex }))`);
    check(docMatch.length === 2 && docMatch.every((d) => Number.isInteger(d.idx)), '讲义自动匹配到分集', JSON.stringify(docMatch));

    // P3 无障碍与语义
    const aria = await cdp.eval(`(() => {
      const controls = ['btnPlay', 'btnPrev', 'btnNext', 'btnMute', 'btnFull']
        .map((id) => document.getElementById(id)?.getAttribute('aria-label') || '');
      const list = document.getElementById('episodeList');
      const tree = document.getElementById('subjectTree');
      const tabs = [...document.querySelectorAll('#dockTabs [role=tab]')];
      return {
        controls,
        listRole: list.getAttribute('role'),
        listSelected: [...list.querySelectorAll('.ep-row')].filter((r) => r.getAttribute('aria-selected') === 'true').length,
        treeRole: tree.getAttribute('role'),
        treeExpanded: [...tree.querySelectorAll('.subject-name')].every((h) => h.hasAttribute('aria-expanded')),
        tablist: document.getElementById('dockTabs').getAttribute('role'),
        tabs: tabs.length,
        tabSelected: tabs.filter((b) => b.getAttribute('aria-selected') === 'true').length,
        rowActionsLabelled: [...document.querySelectorAll('.ep-row .row-btn')].every((b) => !!b.getAttribute('aria-label')),
      };
    })()`);
    check(aria.controls.every(Boolean), '播放控制 5 个图标按钮 aria-label 全齐', JSON.stringify(aria.controls));
    check(aria.listRole === 'listbox' && aria.listSelected === 1, '分集列表 role=listbox + aria-selected', JSON.stringify(aria));
    check(aria.treeRole === 'tree' && aria.treeExpanded, '科目树 role=tree + aria-expanded', JSON.stringify(aria));
    check(aria.tablist === 'tablist' && aria.tabs === 3 && aria.tabSelected === 1, '停靠区 role=tablist/tab + aria-selected', JSON.stringify(aria));
    check(aria.rowActionsLabelled, '行内操作按钮有可读名称', String(aria.rowActionsLabelled));

    // ---- P3：980px 窗宽 + AI / 讲义浮层 ----
    console.log('\n[P3] 980px 断点');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'ai'`, { label: '980 AI 打开' });
    const narrowAi = await cdp.eval(`(() => { const m=document.getElementById('main'); const p=document.getElementById('playerPanel').getBoundingClientRect(); const d=document.getElementById('dock').getBoundingClientRect(); return { main:Math.round(m.clientWidth), player:Math.round(p.width), dock:Math.round(d.width), pos:getComputedStyle(document.getElementById('dock')).position, overflow:m.scrollWidth>m.clientWidth+1 }; })()`);
    check(narrowAi.player >= 420 && !narrowAi.overflow, '980 + AI：播放器 ≥420px 且无横向溢出', JSON.stringify(narrowAi));
    check(narrowAi.pos === 'absolute', '980 + AI：停靠区为浮层，不参与 flex', JSON.stringify(narrowAi));
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockTab === 'docs'`, { label: '980 讲义打开' });
    const narrowDocs = await cdp.eval(`(() => { const m=document.getElementById('main'); const p=document.getElementById('playerPanel').getBoundingClientRect(); const d=document.getElementById('dock').getBoundingClientRect(); return { main:Math.round(m.clientWidth), player:Math.round(p.width), dock:Math.round(d.width), pos:getComputedStyle(document.getElementById('dock')).position, overflow:m.scrollWidth>m.clientWidth+1, docs:document.querySelectorAll('#docsList .doc-item').length }; })()`);
    check(narrowDocs.player >= 420 && !narrowDocs.overflow, '980 + 讲义：播放器 ≥420px 且无横向溢出', JSON.stringify(narrowDocs));
    check(narrowDocs.docs === 2, '980 讲义页签内容完整', String(narrowDocs.docs));
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);

    // ---- P3：1024–1279 图标轨 + 常驻/浮层停靠区 ----
    console.log('\n[P3] 1100px 图标轨');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1100, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true`, { label: '1100 AI 打开' });
    const mid = await cdp.eval(`(() => { const m=document.getElementById('main'); const w=(s)=>Math.round(document.querySelector(s).getBoundingClientRect().width); return { nav:w('#sidebar'), list:w('#episodePanel'), dock:w('#dock'), player:w('#playerPanel'), pos:getComputedStyle(document.getElementById('dock')).position, overflow:m.scrollWidth>m.clientWidth+1 }; })()`);
    check(mid.nav === 64 && mid.list === 288 && mid.dock === 300, '1100：导航 64 / 分集 288 / 停靠 300', JSON.stringify(mid));
    check(mid.player >= 420 && !mid.overflow && mid.pos === 'relative', '1100 + AI：播放器 ≥420px、停靠区常驻', JSON.stringify(mid));
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'drawer'`, { label: '1100 侧栏抽屉打开' });
    const drawer = await cdp.eval(`(() => { const s=document.getElementById('sidebar'); const m=document.getElementById('main'); const r=s.getBoundingClientRect(); return { width:Math.round(r.width), pos:getComputedStyle(s).position, scrim:getComputedStyle(document.getElementById('navScrim')).display, overflow:m.scrollWidth>m.clientWidth+1 }; })()`);
    check(drawer.width === 232 && drawer.pos === 'absolute' && drawer.scrim === 'block', '1100：侧栏抽屉为 232px 浮层', JSON.stringify(drawer));
    await cdp.eval(`document.getElementById('navScrim').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav !== 'drawer'`, { label: '1100 抽屉关闭' });
    check(true, '1100：点击背板关闭侧栏抽屉');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(400);

    // 停靠区宽度沿用 settings.panelWidths.ai，并按断点钳制
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true`, { label: '宽度偏好测试打开 AI' });
    await cdp.eval(`window.__T.actions.setPanelWidths({ ai: 300 })`);
    await sleep(150);
    check((await cdp.eval(`Math.round(document.getElementById('dock').getBoundingClientRect().width)`)) === 300, '停靠区宽度沿用 settings.panelWidths.ai');
    await cdp.eval(`window.__T.actions.setPanelWidths({ ai: 620 })`);
    await sleep(150);
    const clamped = await cdp.eval(`(() => { const d=document.getElementById('dock').getBoundingClientRect(); const p=document.getElementById('playerPanel').getBoundingClientRect(); return { dock:Math.round(d.width), player:Math.round(p.width) }; })()`);
    check(clamped.dock === 340 && clamped.player >= 420, '停靠区宽度按 1344 断点钳制且不挤压播放器', JSON.stringify(clamped));
    await cdp.eval(`document.getElementById('btnAI').click()`);

    // 讲义移除（放在所有依赖 2 份讲义的断言之后）
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'docs'`, { label: '移除讲义前打开页签' });
    const removedPath = await cdp.eval(`(() => {
      const items = [...document.querySelectorAll('#docsList .doc-item')];
      const last = items[items.length - 1];
      const btn = last && last.querySelector('.d-btn[data-act="del"]');
      if (!btn) return null;
      const path = btn.dataset.docPath;
      btn.click();
      return path;
    })()`);
    await cdp.waitFor(`document.querySelectorAll('#docsList .doc-item').length === 1`, { label: '讲义移除' });
    check(!!removedPath && (await cdp.eval(`(window.__T.get().library.docsIgnored[${JSON.stringify(fixture.courses['高数'])}] || []).includes(${JSON.stringify(removedPath)})`)) === true, '讲义可移除且写入忽略清单');
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, { label: '移除讲义后关闭页签' });

    // 宽窗口侧栏折叠 -> 图标轨，并记忆到 localStorage
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'rail'`, { label: '侧栏折叠为图标轨' });
    const railState = await cdp.eval(`({ width:Math.round(document.getElementById('sidebar').getBoundingClientRect().width), stored:localStorage.getItem('vds.navCollapsed') })`);
    check(railState.width === 64 && railState.stored === 'true', '1344：侧栏可折叠为 64 图标轨并记忆', JSON.stringify(railState));
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'expanded'`, { label: '侧栏恢复展开' });
    check((await cdp.eval(`Math.round(document.getElementById('sidebar').getBoundingClientRect().width)`)) === 232, '1344：侧栏可恢复 232 展开');

    // ---- 5. 运行时异常 ----
    console.log('\n[5/5] 运行时异常');
    check(cdp.exceptions.length === 0, '无未捕获异常', cdp.exceptions.slice(0, 3).join(' | '));
    check(cdp.consoleErrors.length === 0, '无 console.error', cdp.consoleErrors.slice(0, 3).join(' | '));
    check(cdp.cspViolations.length === 0, '无 CSP violation', cdp.cspViolations.slice(0, 3).join(' | '));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(600);
  }
  return views;
}

/* ---------------- P3：真实 99 集 ---------------- */

async function runRealData() {
  const snapshotPath = path.join(ROOT, '.backup', 'v0.4.4-20261022-225826', 'learn.json.snapshot');
  if (!fs.existsSync(snapshotPath)) {
    check(false, '真实 99 集数据快照存在', snapshotPath);
    return;
  }
  const store = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
  const profile = makeProfile('real99', store);
  const { cdp, child } = await bootApp(profile, 9354, 'real99');
  try {
    console.log('\n[P3] 真实 99 集');
    await cdp.waitFor(`document.querySelectorAll('.ep-row').length === 99`, { timeout: 20000, label: '99 集渲染' });
    const measure = async (label) => cdp.eval(`(() => {
      const main = document.getElementById('main');
      const titles = [...document.querySelectorAll('.ep-row .title')];
      const p = document.getElementById('playerPanel').getBoundingClientRect();
      const d = document.getElementById('dock').getBoundingClientRect();
      return {
        label: ${JSON.stringify(label)},
        rows: document.querySelectorAll('.ep-row').length,
        player: Math.round(p.width),
        dock: Math.round(d.width),
        overflow: main.scrollWidth > main.clientWidth + 1,
        truncated: titles.filter((t) => t.scrollWidth > t.clientWidth + 1).length,
        clampOverflow: titles.filter((t) => t.scrollHeight > t.clientHeight + 1).length,
      };
    })()`);
    const desktop = await measure('1344-closed');
    check(desktop.rows === 99, '真实数据渲染 99 行', String(desktop.rows));
    check(desktop.truncated === 0 && desktop.clampOverflow === 0, '1344 下 99 集标题截断数 = 0', JSON.stringify(desktop));
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true`, { label: '真实数据 AI 打开' });
    const wideAi = await measure('1344-ai');
    check(wideAi.player >= 420 && !wideAi.overflow, '真实数据 1344 + AI：播放器 ≥420px', JSON.stringify(wideAi));
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 980, height: 760, deviceScaleFactor: 1, mobile: false });
    await sleep(400);
    const narrowAi = await measure('980-ai');
    check(narrowAi.player >= 420 && !narrowAi.overflow && narrowAi.truncated === 0, '真实数据 980 + AI：播放器 ≥420px、标题不截断', JSON.stringify(narrowAi));
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockTab === 'docs'`, { label: '真实数据讲义打开' });
    const narrowDocs = await measure('980-docs');
    check(narrowDocs.player >= 420 && !narrowDocs.overflow, '真实数据 980 + 讲义：播放器 ≥420px、无横向溢出', JSON.stringify(narrowDocs));
    check(cdp.exceptions.length === 0, '真实数据无未捕获异常', cdp.exceptions.slice(0, 2).join(' | '));
    check(cdp.consoleErrors.length === 0, '真实数据无 console.error', cdp.consoleErrors.slice(0, 2).join(' | '));
    check(cdp.cspViolations.length === 0, '真实数据无 CSP violation', cdp.cspViolations.slice(0, 2).join(' | '));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(500);
  }
}

/* ---------------- P3：纯键盘链路 ---------------- */

async function runKeyboard(fixture) {
  const profile = makeProfile('keyboard', {
    roots: [fixture.root],
    settings: {
      theme: 'dark', rate: 1, volume: 0.9, autoNext: true,
      lastCoursePath: fixture.courses['高数'], lastEpisodePath: '',
      panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
    },
  });
  const { cdp, child } = await bootApp(profile, 9355, 'keyboard');
  try {
    console.log('\n[P3] 纯键盘链路');
    const focusedCourse = await cdp.eval(`(() => {
      const item = [...document.querySelectorAll('.course-item')].find((el) => el.textContent.includes('高数'));
      if (!item) return false;
      item.focus();
      return document.activeElement === item;
    })()`);
    check(focusedCourse, '键盘可聚焦课程项', String(focusedCourse));
    await sendKey(cdp, 'Enter');
    await cdp.waitFor(`window.__T.get().library.course && window.__T.get().library.course.name === '高数'`, { label: 'Enter 选课' });
    check(true, '纯键盘选课');

    let onRow = false;
    for (let i = 0; i < 12; i++) {
      await sendKey(cdp, 'Tab');
      if ((await activeInfo(cdp)).row) { onRow = true; break; }
    }
    check(onRow, 'Tab 可到达分集列表');
    await sendKey(cdp, 'Enter');
    await cdp.waitFor(`window.__T.get().playback.index === 0 && window.__T.video().duration > 0`, { label: 'Enter 播放首集' });
    check(true, '纯键盘选集并播放');

    await sendKey(cdp, 'Space');
    await cdp.waitFor(`window.__T.video().paused === true`, { label: 'Space 暂停' });
    check(true, 'Space 暂停');
    await sendKey(cdp, 'Space');
    await cdp.waitFor(`window.__T.video().paused === false`, { label: 'Space 播放' });
    check(true, 'Space 继续播放');

    await cdp.eval(`window.__T.video().pause()`);
    await sendKey(cdp, 'ArrowDown');
    check((await activeInfo(cdp)).row, 'ArrowDown 在列表内移动焦点');
    await sendKey(cdp, 'Enter');
    await cdp.waitFor(`window.__T.get().playback.index === 1`, { label: 'Enter 切到第 2 集' });
    check(true, '纯键盘切集');

    await sendKey(cdp, 'i', { code: 'KeyI', modifiers: 2 });
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true && document.activeElement.id === 'aiInput'`, { label: 'Ctrl+I 打开 AI' });
    check(true, 'Ctrl+I 打开 AI 并聚焦输入框');
    await sendKey(cdp, 'Escape');
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, { label: 'Esc 关闭 AI 浮层' });
    check((await activeInfo(cdp)).row, 'Esc 关闭 AI 后焦点回到分集行');
    await sendKey(cdp, 'i', { code: 'KeyI', modifiers: 2 });
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true && document.activeElement.id === 'aiInput'`, { label: '再次 Ctrl+I 打开 AI' });
    await sendKey(cdp, 'i', { code: 'KeyI', modifiers: 2 });
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, { label: 'Ctrl+I 关闭 AI' });
    const afterAi = await activeInfo(cdp);
    check(afterAi.row, 'Ctrl+I 关闭后焦点回到分集行', JSON.stringify(afterAi));

    await cdp.eval(`document.getElementById('btnSettings').focus()`);
    await sendKey(cdp, 'Enter');
    await cdp.waitFor(`document.getElementById('settingsModal').open === true`, { label: 'Enter 打开设置' });
    const inside = await cdp.eval(`document.getElementById('settingsModal').contains(document.activeElement)`);
    check(inside, '设置弹窗打开时焦点在弹窗内', String(inside));
    let trapped = true;
    for (let i = 0; i < 8; i++) {
      await sendKey(cdp, 'Tab');
      if (!(await cdp.eval(`document.getElementById('settingsModal').contains(document.activeElement)`))) trapped = false;
    }
    check(trapped, 'Tab 焦点陷阱停留在设置弹窗内');
    await sendKey(cdp, 'Escape');
    await cdp.waitFor(`document.getElementById('settingsModal').open === false`, { label: 'Esc 关闭设置' });
    check((await cdp.eval(`document.activeElement.id`)) === 'btnSettings', 'Esc 关闭设置后焦点回到触发按钮');

    // 点击背板关闭（保留旧行为）
    await sendKey(cdp, 'Enter');
    await cdp.waitFor(`document.getElementById('settingsModal').open === true`, { label: '再次打开设置' });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: 5, y: 400, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: 5, y: 400, button: 'left', clickCount: 1 });
    await cdp.waitFor(`document.getElementById('settingsModal').open === false`, { label: '点击背板关闭设置' });
    check((await cdp.eval(`document.activeElement.id`)) === 'btnSettings', '点击背板关闭后焦点回到触发按钮');

    await sendKey(cdp, '?', { code: 'Slash', modifiers: 8, text: '?' });
    await cdp.waitFor(`document.getElementById('helpDialog').open === true`, { label: '? 打开帮助' });
    check((await cdp.eval(`document.activeElement.id`)) === 'helpClose', '? 打开帮助并聚焦关闭按钮');
    await sendKey(cdp, 'Escape');
    await cdp.waitFor(`document.getElementById('helpDialog').open === false`, { label: 'Esc 关闭帮助' });
    check(true, 'Esc 关闭帮助面板');

    await sendKey(cdp, 'k', { code: 'KeyK', modifiers: 2 });
    check((await cdp.eval(`document.activeElement.id`)) === 'globalSearch', 'Ctrl+K 聚焦全局搜索');

    check(cdp.exceptions.length === 0, '纯键盘链路无未捕获异常', cdp.exceptions.slice(0, 2).join(' | '));
    check(cdp.consoleErrors.length === 0, '纯键盘链路无 console.error', cdp.consoleErrors.slice(0, 2).join(' | '));
    check(cdp.cspViolations.length === 0, '纯键盘链路无 CSP violation', cdp.cspViolations.slice(0, 2).join(' | '));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(500);
  }
}

/* ---------------- P3：AI 流式 / 截图 / 中断 / 清空 ---------------- */

function waitPort(port) {
  return new Promise((resolve, reject) => {
    const end = Date.now() + 5000;
    const tick = () => {
      http.get(`http://127.0.0.1:${port}/`, () => resolve(true)).on('error', () => {
        if (Date.now() > end) reject(new Error(`mock 未在 ${port} 就绪`));
        else setTimeout(tick, 120);
      });
    };
    tick();
  });
}

async function runAi(fixture) {
  const mock = spawn(process.execPath, [path.join(ROOT, 'scripts', 'mock-openai.js'), '18779'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  let cdp = null;
  let child = null;
  try {
    await waitPort(18779);
    const profile = makeProfile('ai', {
      roots: [fixture.root],
      settings: {
        theme: 'dark', rate: 1, volume: 0.9, autoNext: true,
        lastCoursePath: fixture.courses['高数'], lastEpisodePath: '',
        panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
      },
      ai: {
        baseUrl: 'http://127.0.0.1:18779/v1',
        apiKey: 'test-key',
        model: 'mock-model',
        contextEnabled: true,
        systemPrompt: '测试提示词',
      },
    });
    const booted = await bootApp(profile, 9356, 'ai');
    cdp = booted.cdp;
    child = booted.child;
    console.log('\n[P3] AI 流式 / 截图 / 中断 / 清空');
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor(`window.__T.get().playback.index === 0 && window.__T.video().duration > 0`, { label: 'AI 用例起播' });
    await cdp.eval(`(() => { const v=window.__T.video(); v.currentTime=6; v.pause(); })()`);
    await sleep(300);
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`document.activeElement.id === 'aiInput'`, { label: 'AI 页签聚焦' });
    check((await cdp.eval(`document.getElementById('aiCtxChip').textContent`)).includes('开'), 'AI 上下文开关默认开');
    await cdp.eval(`document.getElementById('aiCtxChip').click()`);
    await cdp.waitFor(`window.__T.get().ai.config.contextEnabled === false`, { label: 'AI 上下文关闭' });
    await cdp.eval(`document.getElementById('aiCtxChip').click()`);
    await cdp.waitFor(`window.__T.get().ai.config.contextEnabled === true`, { label: 'AI 上下文重新开启' });
    check(true, 'AI 上下文开关可切回并写入 store.ai');

    await cdp.eval(`(() => { const i=document.getElementById('aiInput'); i.value='什么是极限？'; })()`);
    await cdp.eval(`document.getElementById('aiSend').click()`);
    await cdp.waitFor(`window.__T.get().ai.streaming === true`, { label: 'AI 流式开始' });
    await cdp.waitFor(`window.__T.get().ai.streaming === false && window.__T.get().ai.messages.length >= 2`, { timeout: 20000, label: 'AI 流式结束' });
    const rich = await cdp.eval(`(() => {
      const boxes=[...document.querySelectorAll('#aiMsgs .ai-msg.assistant .ai-content')];
      const last=boxes[boxes.length-1];
      return { strong:!!last?.querySelector('strong'), list:!!last?.querySelector('li'), code:!!last?.querySelector('pre code'), text:last?.textContent.length||0 };
    })()`);
    check(rich.strong && rich.list && rich.code, 'AI Markdown 渲染（粗体/列表/代码块）', JSON.stringify(rich));

    await cdp.eval(`(() => { const i=document.getElementById('aiInput'); i.value='请讲一下定积分'; })()`);
    await cdp.eval(`document.getElementById('aiSend').click()`);
    await cdp.waitFor(`window.__T.get().ai.messages.length >= 4 && window.__T.get().ai.streaming === false`, { timeout: 25000, label: 'AI 公式回答' });
    const katex = await cdp.eval(`(() => ({ inline:document.querySelectorAll('#aiMsgs .katex').length, display:document.querySelectorAll('#aiMsgs .katex-display').length }))()`);
    check(katex.inline >= 1 && katex.display >= 1, 'AI KaTeX 公式渲染（行内 + 独立公式）', JSON.stringify(katex));
    const katexStyles = await cdp.eval(`(() => {
      const nodes = [...document.querySelectorAll('#aiMsgs .katex [style]')];
      return { count: nodes.length, sample: nodes[0] ? nodes[0].getAttribute('style') : '' };
    })()`);
    check(
      katexStyles.count > 0 && /height|vertical-align|width/.test(katexStyles.sample),
      'KaTeX 布局样式已通过 CSSOM 回填（无 CSP 违规）',
      JSON.stringify(katexStyles),
    );

    await cdp.eval(`document.getElementById('aiShot').click()`);
    await cdp.waitFor(`!document.getElementById('aiShotBar').classList.contains('hidden')`, { timeout: 15000, label: '截图就绪' });
    check(true, '截图提问截帧成功');
    await cdp.eval(`(() => { const i=document.getElementById('aiInput'); i.value='这屏讲了什么？'; })()`);
    await cdp.eval(`document.getElementById('aiSend').click()`);
    await cdp.waitFor(`window.__T.get().ai.messages.length >= 6 && window.__T.get().ai.streaming === false`, { timeout: 25000, label: '截图提问完成' });
    const image = await cdp.eval(`(() => {
      const msgs=window.__T.get().ai.messages;
      const last=msgs[msgs.length-1];
      return { imgAt:msgs[4] && msgs[4].imgAt, content:last.content.slice(0,160), hasImgData:!!(msgs[4] && msgs[4].imgData) };
    })()`);
    check(!!image.imgAt && image.content.includes('已收到截图'), '截图随提问发送 + 上下文注入', JSON.stringify(image));
    check(image.hasImgData === false, '截图 base64 不留在会话状态', String(image.hasImgData));

    await cdp.eval(`(() => { const i=document.getElementById('aiInput'); i.value='请总结这一节'; })()`);
    await cdp.eval(`document.getElementById('aiSend').click()`);
    await sleep(120);
    await cdp.eval(`document.getElementById('aiSend').click()`);
    await cdp.waitFor(`window.__T.get().ai.streaming === false`, { timeout: 8000, label: 'AI 中断' });
    const aborted = await cdp.eval(`(() => {
      const ai=window.__T.get().ai;
      const last=ai.messages[ai.messages.length-1];
      return { error:ai.error, content:last && last.content, role:last && last.role };
    })()`);
    check(aborted.error === '已停止' || (aborted.content || '').includes('回答被中断'), 'AI 中断保留已收到内容', JSON.stringify(aborted));

    await cdp.eval(`(() => { window.confirm = () => true; document.getElementById('aiClear').click(); })()`);
    await cdp.waitFor(`window.__T.get().ai.messages.length === 0`, { label: 'AI 清空对话' });
    await sleep(500);
    const histPath = path.join(profile, 'ai-history.json');
    const hist = fs.existsSync(histPath) ? JSON.parse(fs.readFileSync(histPath, 'utf8')).messages.length : null;
    check(hist === 0 || hist === null, '清空历史同步 ai-history.json', String(hist));

    check(cdp.exceptions.length === 0, 'AI 链路无未捕获异常', cdp.exceptions.slice(0, 2).join(' | '));
    check(cdp.consoleErrors.length === 0, 'AI 链路无 console.error', cdp.consoleErrors.slice(0, 2).join(' | '));
    check(cdp.cspViolations.length === 0, 'AI 链路无 CSP violation', cdp.cspViolations.slice(0, 2).join(' | '));
  } finally {
    cdp?.close();
    if (child) killTree(child.pid);
    try { mock.kill(); } catch { /* 已退出 */ }
    await sleep(500);
  }
}

async function runEmpty() {
  const profile = makeProfile('empty', { roots: [] });
  const { cdp, child } = await bootApp(profile, 9352, 'empty');
  const views = {};
  try {
    await cdp.waitFor(`!document.getElementById('emptyState').classList.contains('hidden')`, { label: '空状态出现' });
    check((await cdp.eval('window.__T.get().library.subjects.length')) === 0, '空库无科目');
    await setTheme(cdp, 'dark');
    views['empty-dark'] = await snapshot(cdp, 'empty-dark');
    await cdp.screenshot(path.join(BASELINE_DIR, 'empty-dark.png'));
    await setTheme(cdp, 'light');
    views['empty-light'] = await snapshot(cdp, 'empty-light');
    await cdp.screenshot(path.join(BASELINE_DIR, 'empty-light.png'));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(400);
  }
  return views;
}

async function runLegacy(fixture) {
  const profile = makeProfile('legacy', {
    roots: [fixture.root],
    settings: {
      theme: 'dark',
      rate: 1,
      volume: 0.9,
      autoNext: true,
      lastCoursePath: fixture.courses['高数'],
      lastEpisodePath: '',
      panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
    },
  });
  const { cdp, child } = await bootApp(profile, 9353, 'legacy', { search: '?legacy=1' });
  try {
    console.log('\n[P2] ?legacy=1 双轨');
    const boot = await cdp.eval(`({
      mode: document.documentElement.dataset.appMode,
      rows: document.querySelectorAll('.ep-row').length,
      current: state.course && state.course.name,
      ai: typeof window.toggleAI === 'function',
    })`);
    check(boot.mode === 'legacy', '?legacy=1 走旧界面', JSON.stringify(boot));
    check(boot.rows === 3 && boot.current === '高数', '旧界面恢复课程/分集', JSON.stringify(boot));
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('state.index === 0 && video.duration > 0', { timeout: 10000, label: '旧界面起播' });
    const playing = await cdp.eval(`({ paused: video.paused, duration: video.duration, title: state.course.episodes[0].title })`);
    check(playing.duration > 35, '?legacy=1 能播放', JSON.stringify(playing));
    check(boot.ai, '旧界面 ai.js 仍加载', String(boot.ai));
    check(cdp.exceptions.length === 0, '?legacy=1 无未捕获异常', cdp.exceptions.slice(0, 3).join(' | '));
    check(cdp.consoleErrors.length === 0, '?legacy=1 无 console.error', cdp.consoleErrors.slice(0, 3).join(' | '));
    check(cdp.cspViolations.length === 0, '?legacy=1 无 CSP violation', cdp.cspViolations.slice(0, 3).join(' | '));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(400);
  }
}

/* ---------------- P4：打包产物冒烟 ---------------- */

async function runPackaged(fixture) {
  console.log('\n[P4] 打包产物');
  checkPackagedArtifacts();

  const profile = makeProfile('packaged', {
    roots: [fixture.root],
    settings: {
      theme: 'dark',
      rate: 1,
      volume: 0.9,
      autoNext: true,
      lastCoursePath: fixture.courses['高数'],
      lastEpisodePath: '',
      panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
    },
  });
  const { cdp, child } = await bootApp(profile, 9361, 'packaged');
  try {
    const tree = await cdp.eval(`(() => {
      const s = window.__T.get();
      return {
        mode: document.documentElement.dataset.appMode,
        href: location.href,
        rows: document.querySelectorAll('.ep-row').length,
        apiKeys: Object.keys(window.api).length,
        course: s.library.course && s.library.course.name,
        eps: s.library.course ? s.library.course.episodes.length : 0,
      };
    })()`);
    check(tree.mode === 'next', '打包版默认新壳', String(tree.mode));
    check(tree.href.includes('.asar/'), '打包版从 asar 加载 index.html', tree.href);
    check(tree.apiKeys === 26, '打包版 preload 暴露 26 个方法', String(tree.apiKeys));
    check(tree.rows === 3 && tree.course === '高数' && tree.eps === 3, '打包版扫描并恢复课程', JSON.stringify(tree));

    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('window.__T.get().playback.index === 0 && window.__T.video().duration > 0', {
      label: '打包版起播',
    });
    check((await cdp.eval('window.__T.video().duration')) > 35, '打包版播放 40s 夹具');
    await cdp.eval('window.__T.video().pause()');

    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'ai'`, {
      label: '打包版 AI 打开',
    });
    check(true, '打包版 AI 停靠区打开');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor('window.__T.get().ui.dockOpen === false', { label: '打包版 AI 关闭' });

    const href = await cdp.eval('location.href');
    await cdp.send('Page.navigate', { url: href.split('?')[0] + '?legacy=1' });
    await cdp.waitFor(
      `document.documentElement.dataset.appMode === 'legacy' && typeof state !== 'undefined' && state.store && state.subjects`,
      { timeout: 20000, label: '打包版 legacy 启动' },
    );
    const legacy = await cdp.eval(`({
      rows: document.querySelectorAll('.ep-row').length,
      current: state.course && state.course.name,
      ai: typeof window.toggleAI === 'function',
    })`);
    check(legacy.rows === 3 && legacy.current === '高数', '打包版 ?legacy=1 恢复课程/分集', JSON.stringify(legacy));
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('state.index === 0 && video.duration > 0', { timeout: 10000, label: '打包版 legacy 起播' });
    check((await cdp.eval('video.duration')) > 35, '打包版 ?legacy=1 能播放');
    check(legacy.ai, '打包版 ?legacy=1 加载旧 ai.js');

    check(cdp.exceptions.length === 0, '打包版无未捕获异常', cdp.exceptions.slice(0, 3).join(' | '));
    check(cdp.consoleErrors.length === 0, '打包版无 console.error', cdp.consoleErrors.slice(0, 3).join(' | '));
    check(cdp.cspViolations.length === 0, '打包版无 CSP violation', cdp.cspViolations.slice(0, 2).join(' | '));
  } finally {
    cdp.close();
    killTree(child.pid);
    await sleep(500);
  }
}

/* ---------------- 比对 ---------------- */

const VOLATILE_KEYS = new Set(['docMatch']);

function normalize(obj) {
  if (Array.isArray(obj)) return obj.map(normalize);
  if (obj && typeof obj === 'object') {
    return Object.fromEntries(Object.entries(obj).filter(([k]) => !VOLATILE_KEYS.has(k)).map(([k, v]) => [k, normalize(v)]));
  }
  return obj;
}

function diffObjects(expected, actual, prefix = '') {
  const out = [];
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  for (const k of keys) {
    const a = expected?.[k];
    const b = actual?.[k];
    const p = prefix ? `${prefix}.${k}` : k;
    if (a && b && typeof a === 'object' && typeof b === 'object' && !Array.isArray(a)) {
      out.push(...diffObjects(a, b, p));
    } else if (JSON.stringify(a) !== JSON.stringify(b)) {
      out.push(`${p}: ${JSON.stringify(a)} -> ${JSON.stringify(b)}`);
    }
  }
  return out;
}

/* ---------------- 入口 ---------------- */

(async () => {
  if (!fs.existsSync(ELECTRON)) {
    console.error(`未找到 Electron：${ELECTRON}\n先执行 npm install`);
    process.exit(1);
  }
  fs.mkdirSync(BASELINE_DIR, { recursive: true });
  const fixture = ensureFixture();

  console.log(`应用根目录：${ROOT}`);
  console.log(`夹具：${fixture.root}`);
  console.log(`临时数据：${runDir}`);

  console.log('\n[P4] 构建产物');
  checkBuildArtifacts();

  const views = PACKAGED ? {} : { ...(await runLibrary(fixture)), ...(await runEmpty()) };
  if (PACKAGED) {
    await runPackaged(fixture);
  } else {
    await runRealData();
    await runKeyboard(fixture);
    await runAi(fixture);
    await runLegacy(fixture);
  }

  if (!PACKAGED) {
    const actual = { generatedAt: new Date().toISOString(), views };
    if (WRITE_BASELINE) {
      fs.writeFileSync(path.join(BASELINE_DIR, 'dom-snapshot.json'), JSON.stringify(actual, null, 2), 'utf8');
      fs.writeFileSync(path.join(BASELINE_DIR, 'README.md'), [
        '# 基线（P0 建立，P1 / P2 / P3 / P4 更新）',
        '',
        '由 `node scripts/smoke.mjs --write-baseline` 生成。',
        '',
        `- 生成时间：${actual.generatedAt}`,
        `- 夹具：${fixture.root}（由 scripts/fixtures/gen-fixture.mjs 生成）`,
        '- 截图：4 视图 × 2 主题，窗口 1344×821',
        '- dom-snapshot.json：结构性快照；`docMatch` 为易变字段，比对时忽略',
        '',
        'P1 更新说明：仅「讲义自动匹配」修复带来的行内事件按钮变化（默认悬停才可见，静态截图不变）。',
        'P2 更新说明：主视图改为组件化壳 + keyed 增量渲染；8 张截图中 7 张逐像素一致，仅 dashboard 的「活跃天数」由 1 变 0——该值取决于一次毫秒级 timeupdate 是否恰好落在冒烟暂停前，属于统计时序，不是结构/样式变化。',
        'P3 更新说明：P3 有明确视觉变化（停靠区、两行分集行、顶栏导航/帮助按钮、断点栏宽）。8 张截图全部有意变化，逐张原因见 docs/refactor/P3-完成记录.md；dashboard 的「活跃天数」仍可能因同一统计时序为 0。',
        'P4 更新说明：内容哈希构建不改变视觉；截图前统一把鼠标移到左上角，消除空状态按钮 hover 的偶发像素差（empty-* 两图由 hover 态变为无 hover 态），其余 6 张逐像素一致。',
        '',
        '重新生成会覆盖截图，请确认视觉变化是预期的。',
      ].join('\n'), 'utf8');
      console.log(`\n基线已写入 ${BASELINE_DIR}`);
    } else if (fs.existsSync(BASELINE_SNAPSHOT)) {
      const expected = JSON.parse(fs.readFileSync(BASELINE_SNAPSHOT, 'utf8'));
      const diffs = diffObjects(normalize(expected.views), normalize(actual.views));
      if (diffs.length) {
        console.log('\n与基线快照的差异：');
        for (const d of diffs.slice(0, 40)) console.log(`  - ${d}`);
        failures.push(`DOM 快照与基线不一致（${diffs.length} 处）`);
      } else {
        passes.push('DOM 快照与基线一致');
        console.log('\n  ✓ DOM 快照与基线一致');
      }
    } else {
      console.log('\n未找到基线快照，跳过比对（可用 --write-baseline 生成）');
    }
  }

  if (!KEEP) {
    try {
      fs.rmSync(runDir, { recursive: true, force: true });
    } catch {
      /* 文件占用时保留 */
    }
  } else {
    console.log(`\n临时数据保留在：${runDir}`);
  }

  console.log(`\n断言：${passes.length} 通过 / ${failures.length} 失败`);
  if (failures.length) {
    for (const f of failures) console.log(`  ✗ ${f}`);
    process.exit(1);
  }
  console.log('smoke 通过');
  process.exit(0);
})().catch((err) => {
  console.error('\nsmoke 异常：', err);
  process.exit(1);
});
