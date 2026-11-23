/**
 * 无边框磨砂玻璃视觉抽查脚本（只写 ui-audit/<out>，不改应用数据与视觉基线）。
 * 用法：node ui-audit/capture-frosted.mjs [--out frosted-shots] [--css 样式表] [--rects 输出.json]
 * 覆盖：课程 / 看板 / 空状态 × 深浅主题，AI / 讲义页签，搜索下拉，分集悬停预览，
 *       Toast，设置 / 导入 / 帮助弹窗，图标轨，1100 / 980 断点（停靠浮层 + 侧栏抽屉），?legacy=1。
 * --css    用 CDP 拦截 style.css 请求并换成指定文件（对比新旧样式时不用来回替换文件）
 * --rects  每个场景导出全部元素的位置尺寸，用于新旧样式的逐元素布局比对
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist',
  process.platform === 'win32' ? 'electron.exe' : 'electron');
const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null;
};
const OUT = path.join(ROOT, 'ui-audit', argOf('--out') || 'frosted-shots');
const CSS_OVERRIDE = argOf('--css') ? path.resolve(argOf('--css')) : null;
const RECTS_FILE = argOf('--rects') ? path.resolve(argOf('--rects')) : null;
const PORT = 9368;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const failures = [];

/** 页内执行：给每个可见元素生成稳定 key，并导出位置尺寸（保留 1 位小数） */
const RECT_SNIPPET = `(() => {
  const keyOf = (el) => {
    const parts = [];
    for (let n = el; n && n.nodeType === 1 && n !== document.documentElement; n = n.parentElement) {
      let part = n.tagName.toLowerCase();
      if (n.id) part += '#' + n.id;
      else if (n.classList.length) part += '.' + [...n.classList].sort().join('.');
      const parent = n.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((c) => c.tagName === n.tagName);
        if (sibs.length > 1) part += ':' + sibs.indexOf(n);
      }
      parts.unshift(part);
    }
    return parts.join('>');
  };
  const out = [];
  for (const el of document.querySelectorAll('body *')) {
    if (el.closest('.icon-sprite')) continue;
    if (el.closest('svg') && el.tagName.toLowerCase() !== 'svg') continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const f = (v) => Math.round(v * 10) / 10;
    out.push([keyOf(el), f(r.x), f(r.y), f(r.width), f(r.height)]);
  }
  return out;
})()`;

function ensureFixture() {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'fixtures', 'gen-fixture.mjs')], {
    encoding: 'utf8',
    windowsHide: true,
  });
  return JSON.parse(out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1));
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 0;
    this.pending = new Map();
    this.exceptions = [];
    this.cspViolations = [];
  }
  async open() {
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
    await this.send('Log.enable');
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.method === 'Fetch.requestPaused') {
        // 换掉 style.css 的响应，其余请求照常放行
        if (CSS_OVERRIDE && /style\.css/.test(msg.params.request.url)) {
          this.send('Fetch.fulfillRequest', {
            requestId: msg.params.requestId,
            responseCode: 200,
            responseHeaders: [
              { name: 'Content-Type', value: 'text/css' },
              { name: 'Cache-Control', value: 'no-store' },
            ],
            body: fs.readFileSync(CSS_OVERRIDE).toString('base64'),
          }).catch(() => {});
        } else {
          this.send('Fetch.continueRequest', { requestId: msg.params.requestId }).catch(() => {});
        }
        return;
      }
      if (msg.method === 'Runtime.exceptionThrown') {
        this.exceptions.push(msg.params?.exceptionDetails?.text || 'exception');
      }
      const text = msg.params?.entry?.text || '';
      if (msg.method === 'Log.entryAdded' && /Content Security Policy|Refused to/i.test(text)) this.cspViolations.push(text);
    });
    if (CSS_OVERRIDE) {
      await this.send('Fetch.enable', { patterns: [{ urlPattern: '*style.css*', requestStage: 'Request' }] });
    }
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
      includeCommandLineAPI: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text || 'eval failed');
    }
    return r.result.value;
  }
  async waitFor(expression, label = expression, timeout = 12000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const ok = await this.eval(`(() => { try { return !!(${expression}); } catch { return false; } })()`).catch(() => false);
      if (ok) return true;
      await sleep(120);
    }
    throw new Error(`等待超时：${label}`);
  }
  moveMouse(x, y) {
    return this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
  }
  /** 把鼠标移到元素中心（真实 hover / 点击态） */
  async hover(selector, index = 0) {
    const pt = await this.eval(`(() => {
      const el = document.querySelectorAll(${JSON.stringify(selector)})[${index}];
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    })()`);
    if (!pt) throw new Error(`hover：找不到 ${selector}[${index}]`);
    await this.moveMouse(pt.x, pt.y);
    await sleep(200);
    return pt;
  }
  async click(selector, index = 0) {
    const pt = await this.hover(selector, index);
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.send('Input.dispatchMouseEvent', { type, x: pt.x, y: pt.y, button: 'left', clickCount: 1 });
    }
    await sleep(120);
  }
  async shot(name, { keepMouse = false } = {}) {
    // 默认把鼠标移到左上角，避免 hover 态造成偶发像素差
    if (!keepMouse) await this.moveMouse(2, 2);
    await sleep(160);
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    if (RECTS_FILE) rects[name.replace(/\.png$/, '')] = await this.eval(RECT_SNIPPET);
    console.log('shot', name);
  }
  /** 放大截图：用于检查阴影层次、颗粒纹理、焦点环等细节 */
  async zoom(name, x, y, width, height, scale = 3) {
    await this.moveMouse(2, 2);
    await sleep(160);
    const r = await this.send('Page.captureScreenshot', { format: 'png', clip: { x, y, width, height, scale } });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('zoom', name);
  }
  metrics(width, height) {
    return this.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

async function connect() {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    try {
      const list = await new Promise((resolve, reject) => {
        http.get(`http://127.0.0.1:${PORT}/json`, (res) => {
          let s = '';
          res.on('data', (d) => (s += d));
          res.on('end', () => { try { resolve(JSON.parse(s)); } catch (e) { reject(e); } });
        }).on('error', reject);
      });
      const target = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (target) {
        const cdp = new Cdp(target.webSocketDebuggerUrl);
        await cdp.open();
        return cdp;
      }
    } catch { /* not ready */ }
    await sleep(250);
  }
  throw new Error('CDP 未就绪');
}

function launch(profile) {
  const env = { ...process.env, VDS_USER_DATA: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const logPath = path.join(profile, 'electron-capture.log');
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(ELECTRON, ['.', `--remote-debugging-port=${PORT}`], {
    cwd: ROOT,
    env,
    stdio: ['ignore', fd, fd],
    windowsHide: false,
  });
  return { child, logPath };
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
  } catch { /* 已退出 */ }
}

/** 启动一个独立 profile，跑完 fn 后关掉应用 */
async function withApp(store, fn, { search = '' } = {}) {
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-frosted-'));
  const profile = path.join(runDir, 'profile');
  fs.mkdirSync(profile, { recursive: true });
  fs.writeFileSync(path.join(profile, 'learn.json'), JSON.stringify(store, null, 2), 'utf8');
  const { child } = launch(profile);
  let cdp = null;
  try {
    cdp = await connect();
    if (search) {
      // 等首屏（现代壳）启动完再导航，避免和主进程的首次加载抢同一条导航
      await cdp.waitFor('window.__VDS_READY === true', '首屏启动', 20000);
      const href = await cdp.eval('location.href');
      await cdp.send('Page.navigate', { url: href.split('?')[0] + search });
      await sleep(400);
    } else if (CSS_OVERRIDE) {
      // 样式表拦截要重新加载才生效；等新文档启动完成，避免读到旧文档的 ready 标记
      const origin = await cdp.eval('performance.timeOrigin');
      await cdp.send('Page.reload');
      await cdp.waitFor(`performance.timeOrigin !== ${origin} && window.__VDS_READY === true`, '换样式表后重新启动', 20000);
      await cdp.eval(`window.__T = {
        get: () => window.__VDS_STORE.get(),
        actions: window.__VDS_ACTIONS,
        video: () => window.__VDS.getVideo(),
      }`);
      await sleep(600);
    }
    if (search.includes('legacy=1')) {
      await cdp.waitFor(
        `document.documentElement.dataset.appMode === 'legacy' && typeof state !== 'undefined' && state.store && state.subjects`,
        '旧界面启动',
        20000,
      );
    } else {
      await cdp.waitFor('window.__VDS_READY === true', '应用启动', 20000);
      await cdp.eval(`window.__T = {
        get: () => window.__VDS_STORE.get(),
        actions: window.__VDS_ACTIONS,
        video: () => window.__VDS.getVideo(),
      }`);
    }
    await sleep(600);
    await fn(cdp);
  } finally {
    cdp?.close();
    killTree(child.pid);
    await sleep(500);
    try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* 文件占用时保留 */ }
  }
}

const setTheme = async (cdp, theme) => {
  await cdp.eval(`(() => {
    const light = document.body.classList.contains('light');
    if ((${JSON.stringify(theme)} === 'light') !== light) document.getElementById('btnTheme').click();
  })()`);
  await cdp.waitFor(`document.body.classList.contains('light') === ${theme === 'light'}`, '主题切换');
  await sleep(120);
};

const rects = {};

/** 单个场景：失败只记录，不中断其余场景 */
async function step(label, fn) {
  try {
    await fn();
  } catch (err) {
    failures.push(`${label}: ${err && err.message ? err.message : err}`);
    console.error(`  ✗ ${label} — ${err && err.message ? err.message : err}`);
  }
}

const fixture = ensureFixture();
const baseSettings = {
  theme: 'dark', rate: 1, volume: 0.9, autoNext: true,
  lastCoursePath: fixture.courses['高数'], lastEpisodePath: '',
  panelWidths: { sidebar: 232, episodes: 320, ai: 360 },
};

/* ---------------- 主场景：有课程的资料库 ---------------- */

await withApp({ roots: [fixture.root], settings: baseSettings }, async (cdp) => {
  await cdp.waitFor(`document.querySelectorAll('.ep-row').length > 0`, '课程加载');

  await step('课程页（深 / 浅）', async () => {
    // 起播后暂停在一个固定位置，画面稳定
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('window.__T.video().duration > 0', '首集起播');
    await cdp.eval(`(() => { const v = window.__T.video(); v.currentTime = 12; v.pause(); })()`);
    await sleep(900);
    await setTheme(cdp, 'dark');
    await cdp.shot('course-dark.png');
    await cdp.zoom('zoom-dark-top-left.png', 0, 0, 300, 250);
    await cdp.zoom('zoom-dark-controls.png', 564, 700, 440, 121);
    await cdp.zoom('zoom-dark-rows.png', 236, 120, 340, 110);
    await setTheme(cdp, 'light');
    await cdp.shot('course-light.png');
    await cdp.zoom('zoom-light-top-left.png', 0, 0, 300, 250);
    await cdp.zoom('zoom-light-controls.png', 564, 700, 440, 121);
    await cdp.zoom('zoom-light-rows.png', 236, 120, 340, 110);
  });

  await step('分集悬停预览 + 行内操作', async () => {
    await setTheme(cdp, 'dark');
    await cdp.hover('.ep-row', 1);
    await cdp.waitFor(`!document.getElementById('hoverPreview').classList.contains('hidden')`, '悬停预览', 6000);
    await sleep(500);
    await cdp.shot('hover-row-dark.png', { keepMouse: true });
  });

  await step('AI 页签（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen && window.__T.get().ui.dockTab === 'ai'`, 'AI 页签打开');
    await sleep(300);
    await cdp.shot('ai-dark.png');
    await setTheme(cdp, 'light');
    await cdp.shot('ai-light.png');
  });

  await step('讲义页签', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockTab === 'docs' && document.querySelectorAll('#docsList .doc-item').length > 0`, '讲义页签打开');
    await cdp.hover('#docsList .doc-item', 0);
    await sleep(250);
    await cdp.shot('docs-dark.png', { keepMouse: true });
    await setTheme(cdp, 'light');
    await cdp.shot('docs-light.png');
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnDocs').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, '讲义页签关闭');
  });

  await step('全局搜索下拉（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.click('#globalSearch');
    await cdp.send('Input.insertText', { text: '极限' });
    await cdp.waitFor(`document.querySelectorAll('#searchDrop .gs-item').length > 0`, '搜索出结果');
    await cdp.hover('#searchDrop .gs-item', 0);
    await sleep(250);
    await cdp.shot('search-dark.png', { keepMouse: true });
    await setTheme(cdp, 'light');
    await cdp.shot('search-light.png', { keepMouse: true });
    await cdp.eval(`(() => { const el = document.getElementById('globalSearch'); el.value = ''; el.dispatchEvent(new Event('input', { bubbles: true })); el.blur(); })()`);
    await sleep(200);
  });

  await step('Toast', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`window.__VDS.toast.show('已清理转封装缓存')`);
    await sleep(250);
    await cdp.shot('toast-dark.png');
    await setTheme(cdp, 'light');
    await cdp.eval(`window.__VDS.toast.show('已清理转封装缓存')`);
    await sleep(250);
    await cdp.shot('toast-light.png');
    await sleep(2600);
  });

  await step('学习看板（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    const contPath = await cdp.eval(`window.__T.get().library.course.episodes[0].path`);
    await cdp.eval(`window.__VDS.api.episodeMeta({ path: ${JSON.stringify(contPath)}, thumb: true, duration: true })`);
    await cdp.eval(`document.getElementById('btnHome').click()`);
    await cdp.waitFor(`!document.getElementById('dashboard').classList.contains('hidden')`, '看板打开');
    await cdp
      .waitFor(`(() => { const i = document.getElementById('contThumb'); return !!i && !i.classList.contains('hidden') && i.complete; })()`, '看板缩略图', 6000)
      .catch(() => {});
    await sleep(300);
    await cdp.shot('dashboard-dark.png');
    await setTheme(cdp, 'light');
    await cdp.hover('#contCard');
    await sleep(350);
    await cdp.shot('dashboard-light.png', { keepMouse: true });
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnHome').click()`);
    await cdp.waitFor(`document.getElementById('dashboard').classList.contains('hidden')`, '返回播放视图');
  });

  await step('设置弹窗（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnSettings').click()`);
    await cdp.waitFor(`document.getElementById('settingsModal').open === true`, '设置打开');
    await cdp.eval(`document.getElementById('aiBaseUrl').focus()`);
    await sleep(350);
    await cdp.shot('settings-dark.png');
    await cdp.zoom('zoom-dark-modal.png', 424, 52, 240, 226);
    await cdp.eval(`document.querySelector('#settingsModal .modal-body').scrollTop = 99999`);
    await sleep(250);
    await cdp.shot('settings-dark-bottom.png');
    await setTheme(cdp, 'light');
    await cdp.eval(`document.querySelector('#settingsModal .modal-body').scrollTop = 0`);
    await sleep(250);
    await cdp.shot('settings-light.png');
    await cdp.zoom('zoom-light-modal.png', 424, 52, 240, 226);
    await cdp.eval(`document.getElementById('setClose').click()`);
    await cdp.waitFor(`document.getElementById('settingsModal').open === false`, '设置关闭');
  });

  await step('导入弹窗（深 / 浅）', async () => {
    await setTheme(cdp, 'light');
    await cdp.eval(`window.__T.actions.openImport({ type: 'folder', dirs: [${JSON.stringify(fixture.courses['高数'])}] })`);
    await cdp.waitFor(`document.getElementById('importModal').open === true`, '导入打开');
    await sleep(350);
    await cdp.shot('import-light.png');
    await setTheme(cdp, 'dark');
    await cdp.shot('import-dark.png');
    await cdp.eval(`document.getElementById('impCancel').click()`);
    await cdp.waitFor(`document.getElementById('importModal').open === false`, '导入关闭');
  });

  await step('帮助弹窗（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnHelp').click()`);
    await cdp.waitFor(`document.getElementById('helpDialog').open === true`, '帮助打开');
    await sleep(350);
    await cdp.shot('help-dark.png');
    await setTheme(cdp, 'light');
    await cdp.shot('help-light.png');
    await cdp.eval(`document.getElementById('helpClose').click()`);
    await cdp.waitFor(`document.getElementById('helpDialog').open === false`, '帮助关闭');
  });

  await step('图标轨（侧栏折叠）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'rail'`, '侧栏折叠为图标轨');
    await sleep(300);
    await cdp.shot('rail-dark.png');
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'expanded'`, '侧栏恢复');
  });

  await step('拖放提示 / 播放失败遮罩', async () => {
    await setTheme(cdp, 'dark');
    await cdp.eval(`document.getElementById('dropHint').classList.remove('hidden')`);
    await sleep(200);
    await cdp.shot('drop-hint-dark.png');
    await cdp.eval(`document.getElementById('dropHint').classList.add('hidden')`);
    await cdp.eval(`(() => {
      document.getElementById('ovText').textContent = '「[1.1.1]--函数概念.mkv」不是浏览器内核直接支持的格式（如 MKV/RMVB/FLV），请用系统播放器打开';
      document.getElementById('videoOverlay').classList.remove('hidden');
    })()`);
    await sleep(200);
    await cdp.shot('video-overlay-dark.png');
    await cdp.eval(`document.getElementById('videoOverlay').classList.add('hidden')`);
  });

  await step('降低透明度时的降级（实色面板、无颗粒无环境底）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    const on = await cdp.eval(`matchMedia('(prefers-reduced-transparency: reduce)').matches`);
    if (!on) throw new Error('当前 Chromium 不支持模拟 prefers-reduced-transparency');
    await sleep(300);
    await cdp.shot('fallback-reduced-transparency-dark.png');
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await sleep(200);
  });

  await step('1100：停靠区常驻', async () => {
    await cdp.metrics(1100, 700);
    await sleep(400);
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true`, '1100 AI 打开');
    await sleep(350);
    await cdp.shot('1100-ai-dark.png');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, '1100 AI 关闭');
  });

  await step('980：停靠浮层 + 侧栏抽屉', async () => {
    await cdp.metrics(980, 620);
    await sleep(400);
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === true`, '980 AI 打开');
    await sleep(350);
    await cdp.shot('980-ai-dark.png');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`window.__T.get().ui.dockOpen === false`, '980 AI 关闭');
    await cdp.eval(`document.getElementById('btnNav').click()`);
    await cdp.waitFor(`document.getElementById('main').dataset.nav === 'drawer'`, '980 抽屉打开');
    await sleep(350);
    await cdp.shot('980-drawer-dark.png');
    await setTheme(cdp, 'light');
    await cdp.shot('980-drawer-light.png');
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    await sleep(300);
  });

  if (cdp.exceptions.length) failures.push(`主场景页面异常：${cdp.exceptions.slice(0, 3).join(' | ')}`);
  if (cdp.cspViolations.length) failures.push(`主场景 CSP violation：${cdp.cspViolations.slice(0, 3).join(' | ')}`);
});

/* ---------------- 空库 ---------------- */

await withApp({ roots: [], settings: { ...baseSettings, lastCoursePath: '' } }, async (cdp) => {
  await cdp.waitFor(`!document.getElementById('emptyState').classList.contains('hidden')`, '空状态出现');
  await step('空状态（深 / 浅）', async () => {
    await setTheme(cdp, 'dark');
    await cdp.shot('empty-dark.png');
    await setTheme(cdp, 'light');
    await cdp.hover('#emptyOpenDir');
    await sleep(300);
    await cdp.shot('empty-light.png', { keepMouse: true });
  });
  if (cdp.exceptions.length) failures.push(`空库页面异常：${cdp.exceptions.slice(0, 3).join(' | ')}`);
  if (cdp.cspViolations.length) failures.push(`空库 CSP violation：${cdp.cspViolations.slice(0, 3).join(' | ')}`);
});

/* ---------------- ?legacy=1 旧界面（共用同一份样式表） ---------------- */

await withApp({ roots: [fixture.root], settings: baseSettings }, async (cdp) => {
  await cdp.waitFor(`document.querySelectorAll('.ep-row').length === 3`, '旧界面课程加载');
  await step('?legacy=1', async () => {
    await cdp.eval(`document.querySelectorAll('.ep-row')[0].click()`);
    await cdp.waitFor('video.duration > 0', '旧界面起播', 10000);
    await cdp.eval(`video.pause()`);
    await sleep(500);
    await cdp.shot('legacy-dark.png');
    await setTheme(cdp, 'light');
    // ai.js 由 lib-boot 在 legacy 分支延迟加载，等它挂上处理函数后再点按钮
    await cdp.waitFor(`typeof window.toggleAI === 'function'`, '旧界面 ai.js 加载');
    await cdp.eval(`document.getElementById('btnAI').click()`);
    await cdp.waitFor(`!document.getElementById('aiPanel').classList.contains('hidden')`, '旧界面 AI 侧栏打开');
    await sleep(400);
    await cdp.shot('legacy-light.png');
  });
  if (cdp.exceptions.length) failures.push(`legacy 页面异常：${cdp.exceptions.slice(0, 3).join(' | ')}`);
  if (cdp.cspViolations.length) failures.push(`legacy CSP violation：${cdp.cspViolations.slice(0, 3).join(' | ')}`);
}, { search: '?legacy=1' });

console.log(`\ndone -> ${OUT}`);
if (RECTS_FILE) {
  fs.writeFileSync(RECTS_FILE, JSON.stringify({
    css: CSS_OVERRIDE || 'renderer/style.css',
    views: rects,
  }), 'utf8');
  console.log(`rects -> ${RECTS_FILE}（${Object.keys(rects).length} 个场景）`);
}
if (failures.length) {
  for (const f of failures) console.error(`  ✗ ${f}`);
  process.exit(1);
}
