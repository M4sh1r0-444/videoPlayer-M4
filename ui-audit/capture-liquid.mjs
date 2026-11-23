/**
 * Liquid Glass 视觉抽查脚本（只写 ui-audit/liquid-shots，不改应用数据）。
 * 用法：node ui-audit/capture-liquid.mjs
 * 覆盖：1100/980 断点、浅深色设置/导入/帮助弹窗、分集悬停预览。
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
const OUT = path.join(ROOT, 'ui-audit', 'liquid-shots');
const PORT = 9367;
fs.mkdirSync(OUT, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
  }
  async open() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (!msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
    await this.send('Runtime.enable');
    await this.send('Page.enable');
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
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || 'eval failed');
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
  async shot(name) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 2, y: 2, button: 'none', buttons: 0 });
    await sleep(120);
    const r = await this.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(OUT, name), Buffer.from(r.data, 'base64'));
    console.log('shot', name);
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

const fixture = ensureFixture();
const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vds-liquid-'));
const profile = path.join(runDir, 'profile');
fs.mkdirSync(profile, { recursive: true });
fs.writeFileSync(path.join(profile, 'learn.json'), JSON.stringify({
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
}, null, 2), 'utf8');

const { child } = launch(profile);
let cdp = null;
try {
  cdp = await connect();
  await cdp.waitFor('window.__VDS_READY === true', '应用启动');
  await cdp.eval(`window.__T = {
    get: () => window.__VDS_STORE.get(),
    actions: window.__VDS_ACTIONS,
    video: () => window.__VDS.getVideo(),
  }`);
  await cdp.waitFor(`document.querySelectorAll('.ep-row').length > 0`, '课程加载');
  await sleep(500);

  const setTheme = async (theme) => {
    await cdp.eval(`(() => {
      const light = document.body.classList.contains('light');
      if ((${JSON.stringify(theme)} === 'light') !== light) document.getElementById('btnTheme').click();
    })()`);
    await cdp.waitFor(`document.body.classList.contains('light') === ${theme === 'light'}`, '主题切换');
  };
  const metrics = (width, height) => cdp.send('Emulation.setDeviceMetricsOverride', {
    width, height, deviceScaleFactor: 1, mobile: false,
  });

  // 断点：1100 / 980，AI 常驻与浮层
  await cdp.eval(`document.getElementById('episodeList').querySelector('.ep-row').click()`);
  await sleep(400);
  await cdp.eval(`document.getElementById('btnAI').click()`);
  await cdp.waitFor('window.__T.get().ui.dockOpen === true', 'AI 打开');
  await metrics(1100, 700);
  await sleep(500);
  await cdp.shot('1100-ai-dark.png');
  await metrics(980, 620);
  await sleep(500);
  await cdp.shot('980-ai-dark.png');
  await cdp.send('Emulation.clearDeviceMetricsOverride');
  await sleep(500);
  await cdp.eval(`document.getElementById('btnAI').click()`);
  await cdp.waitFor('window.__T.get().ui.dockOpen === false', 'AI 关闭');

  // 深色设置
  await setTheme('dark');
  await cdp.eval(`document.getElementById('btnSettings').click()`);
  await cdp.waitFor(`document.getElementById('settingsModal').open === true`, '设置打开');
  await cdp.shot('settings-dark.png');
  await cdp.eval(`document.querySelector('#settingsModal .modal-body').scrollTop = 99999`);
  await sleep(250);
  await cdp.shot('settings-dark-bottom.png');
  await cdp.eval(`document.getElementById('setClose').click()`);
  await cdp.waitFor(`document.getElementById('settingsModal').open === false`, '设置关闭');

  // 浅色导入
  await setTheme('light');
  await cdp.eval(`window.__T.actions.openImport({ type: 'folder', dirs: [${JSON.stringify(fixture.courses['高数'])}] })`);
  await cdp.waitFor(`document.getElementById('importModal').open === true`, '导入打开');
  await cdp.shot('import-light.png');
  await cdp.eval(`document.getElementById('impCancel').click()`);
  await cdp.waitFor(`document.getElementById('importModal').open === false`, '导入关闭');

  // 浅色帮助
  await cdp.eval(`document.getElementById('btnHelp').click()`);
  await cdp.waitFor(`document.getElementById('helpDialog').open === true`, '帮助打开');
  await cdp.shot('help-light.png');
  await cdp.eval(`document.getElementById('helpClose').click()`);
  await cdp.waitFor(`document.getElementById('helpDialog').open === false`, '帮助关闭');

  // 悬停预览（深色）
  await setTheme('dark');
  await cdp.eval(`(() => {
    const row = document.querySelectorAll('.ep-row')[1];
    const r = row.getBoundingClientRect();
    row.dispatchEvent(new MouseEvent('mouseover', {
      bubbles: true, clientX: r.left + 40, clientY: r.top + 20,
    }));
  })()`);
  await cdp.waitFor(`!document.getElementById('hoverPreview').classList.contains('hidden')`, '悬停预览');
  await sleep(350);
  await cdp.shot('hover-preview-dark.png');
} finally {
  cdp?.close();
  try { execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
  await sleep(300);
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
console.log('done ->', OUT);
